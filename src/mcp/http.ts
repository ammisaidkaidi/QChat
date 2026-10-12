/**
 * MCP over Streamable HTTP.
 *
 * The same JSON-RPC 2.0 messages as the stdio client, carried in POST requests
 * the way the protocol specifies for remote servers (Supabase's official
 * endpoint is one):
 *
 *   POST <url>  Accept: application/json, text/event-stream
 *   → either a JSON body, or an SSE stream whose `data:` frames hold the reply
 *   ← `mcp-session-id` response header, echoed on later requests
 *
 * Secrets never leave the process: header values are read from the environment
 * at construction time, and every error message and stderr line is passed
 * through `redact()` first, so a token cannot reach a log, the interface or the
 * model.
 *
 * The request identifies itself with a real `User-Agent`: hosted endpoints sit
 * behind an edge (Supabase's is Cloudflare) that answers a bare or library
 * default agent with "403 Error 1010: browser_signature_banned", which looks
 * exactly like an auth failure and is not one.
 */
import {
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpServerConfig,
  type McpTool,
  type McpToolResult,
} from './client.js';

export interface HttpMcpConfig extends McpServerConfig {
  /** Endpoint of the remote server. */
  url: string;
  /** Extra headers, typically `{"Authorization": "Bearer …"}`. */
  headers?: Record<string, string>;
}

/** One header every remote request carries, so an edge cannot mistake us for a scraper. */
export const HTTP_MCP_USER_AGENT =
  'InfAgent/1.0 (+https://github.com/ammisaidkaidi/InfAgent; MCP client)';

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Replace any credential-looking value with `***`, wherever it appears. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) output = output.split(secret).join('***');
  }
  return output
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(sbp|sbp_|sb_secret_|eyJ)[A-Za-z0-9._-]{8,}/g, '***')
    .replace(/([?&](?:apikey|access_token|key|token|password)=)[^&\s]+/gi, '$1***');
}

/** Values in a config that must never be echoed, e.g. authorization headers. */
export function secretsOf(config: {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (/auth|token|key|secret|password/i.test(key)) {
      values.push(value.replace(/^(bearer\s+)/i, '').trim());
    }
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (/token|key|secret|password/i.test(key)) values.push(value);
  }
  return values.filter(Boolean);
}

export class HttpMcpClient {
  public readonly name: string;
  public readonly url: string;
  public state: 'stopped' | 'starting' | 'ready' | 'error' = 'stopped';
  public tools: McpTool[] = [];
  /**
   * When the server last announced a change to its tool list. Always null for
   * this transport: the hosted endpoints do not push notifications, so their
   * list is re-read on every start.
   */
  public readonly toolsChangedAt: string | null = null;
  public serverInfo: { name?: string; version?: string } = {};
  public lastError: string | null = null;
  public readonly stderr: string[] = [];

  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(name: string, config: HttpMcpConfig) {
    this.name = name;
    this.url = config.url;
    this.headers = { ...(config.headers ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.secrets = secretsOf(config);
  }

  /** Where this server lives, with any token in the query string removed. */
  public get displayUrl(): string {
    return redact(this.url, this.secrets);
  }

  private note(line: string): void {
    this.stderr.push(redact(line, this.secrets));
    if (this.stderr.length > 50) this.stderr.shift();
  }

  /** One POST; returns the JSON-RPC reply, unwrapping an SSE frame if needed. */
  private async post(message: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'user-agent': HTTP_MCP_USER_AGENT,
      ...this.headers,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);
      throw new McpError(
        'timeout',
        redact(
          `${this.name}: ${error instanceof Error && error.name === 'TimeoutError' ? 'the request timed out' : `could not reach ${this.displayUrl} (${message_})`}`,
          this.secrets,
        ),
      );
    }

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => '');
      this.note(`${response.status} from ${this.displayUrl}: ${body.slice(0, 200)}`);

      // An edge block is not an authentication problem, and saying it is sends
      // people to the wrong place (we hit exactly that with Cloudflare 1010).
      if (/error 1010|browser_signature|cloudflare|access denied/i.test(body)) {
        throw new McpError(
          'protocol',
          redact(
            `${this.name}: the endpoint's edge refused this client — HTTP ${response.status}` +
              `${/1010/.test(body) ? ' (Cloudflare 1010, browser signature banned)' : ''}. ` +
              'This is not a token problem: retry, or check whether the host blocks automated clients.',
            this.secrets,
          ),
        );
      }

      // A credential-kind mismatch: the header is there, but it is not the
      // shape that endpoint accepts, so it answers 401 with a complaint about
      // decoding rather than about the token. Calling that "check the token"
      // sends people to rotate a credential that may be perfectly good (the
      // same class of lie as the edge case above).
      if (/jwt could not be decoded|expected (a )?jwt|invalid token type/i.test(body)) {
        throw new McpError(
          'protocol',
          redact(
            `${this.name}: the endpoint rejected this credential as the wrong kind (${response.status}) — ` +
              `it is asking for an OAuth/JWT token rather than the access token configured here.` +
              `${body.trim() ? ` Server said: ${body.slice(0, 160)}` : ''} ` +
              'Check which credential the endpoint expects before rotating anything.',
            this.secrets,
          ),
        );
      }

      throw new McpError(
        'protocol',
        `${this.name}: authentication failed (${response.status}). Check the token in this server's headers — it is read from the environment, never from mcp.json.`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new McpError(
        'protocol',
        redact(
          `${this.name}: ${response.status} ${response.statusText} — ${body.slice(0, 300)}`,
          this.secrets,
        ),
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    // 202 with no body is the correct answer to a notification.
    if (!body.trim()) return null;

    if (contentType.includes('text/event-stream')) {
      // Frames are separated by a blank line; `data:` lines hold the JSON.
      for (const frame of body.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as JsonRpcResponse;
          if (parsed.id === message['id']) return parsed;
        } catch {
          continue;
        }
      }
      return null;
    }

    try {
      return JSON.parse(body) as JsonRpcResponse;
    } catch {
      throw new McpError(
        'protocol',
        redact(`${this.name}: reply was not JSON: ${body.slice(0, 200)}`, this.secrets),
      );
    }
  }

  private async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!reply) throw new McpError('protocol', `${this.name}: no reply to ${method}.`);
    if (reply.error)
      throw new McpError('protocol', redact(`${this.name}: ${reply.error.message}`, this.secrets));
    return reply.result;
  }

  async start(): Promise<void> {
    this.state = 'starting';
    this.lastError = null;
    try {
      const result = (await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'InfAgent', version: '0.1.0' },
      })) as { serverInfo?: { name?: string; version?: string } };

      this.serverInfo = result?.serverInfo ?? {};
      // Best effort: a server that ignores the notification is still usable.
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);

      const list = (await this.request('tools/list')) as { tools?: McpTool[] };
      this.tools = (list?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      }));
      this.state = 'ready';
      this.note(`connected to ${this.displayUrl} — ${this.tools.length} tool(s)`);
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.note(this.lastError);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
    this.sessionId = null;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.state !== 'ready') {
      throw new McpError('closed', `${this.name} is not connected (state: ${this.state}).`);
    }

    const startedAt = Date.now();
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    if (!reply) throw new McpError('protocol', `${this.name}: no reply to tools/call ${name}.`);
    if (reply.error) {
      throw new McpError(
        'tool',
        redact(`${this.name}__${name}: ${reply.error.message}`, this.secrets),
      );
    }

    const result = (reply.result ?? {}) as { content?: unknown[]; isError?: boolean };
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .map((block) => {
        const typed = block as { type?: string; text?: string };
        return typed.type === 'text' ? (typed.text ?? '') : JSON.stringify(block);
      })
      .join('\n')
      .trim();

    return {
      ok: result.isError !== true,
      text: redact(text, this.secrets),
      content: result.content ?? null,
      isError: result.isError === true,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Query string of a URL, with anything secret-looking masked. */
export function describeRemote(config: HttpMcpConfig): string {
  try {
    const url = new URL(config.url);
    return `${url.origin}${url.pathname}${url.search ? `?${maskQuery(url.searchParams)}` : ''}`;
  } catch {
    return config.url.slice(0, 80);
  }
}

function maskQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) =>
      /token|key|secret|password/i.test(key) ? `${key}=***` : `${key}=${value}`,
    )
    .join('&');
}
