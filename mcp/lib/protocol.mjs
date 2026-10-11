/**
 * Small stdio server kit for the MCP servers in `mcp/servers/`.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, protocol 2024-11-05:
 * `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * `ping`. Tool failures come back as `isError: true` content (the protocol's
 * own way of reporting a handled failure) instead of a transport error, so the
 * model sees the reason instead of a broken connection.
 */

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * @param {{name:string, version?:string, tools:Array<{name:string, description:string, inputSchema:object, handler:Function}>}} options
 */
export function serve({ name, version = '1.0.0', tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

  const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
  const failure = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const text = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });

  async function call(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) {
      result(id, {
        content: [{ type: 'text', text: `Unknown tool "${params?.name}". Known: ${[...byName.keys()].join(', ')}` }],
        isError: true,
      });
      return;
    }

    try {
      const output = await tool.handler(params.arguments ?? {});
      result(id, text(output));
    } catch (error) {
      // Policy violations and bad input are expected outcomes, not crashes.
      result(id, {
        content: [{ type: 'text', text: `${error.name ?? 'Error'}: ${error.message ?? String(error)}` }],
        isError: true,
      });
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // A malformed line is not worth tearing the session down for.
      }

      // Notifications (no id) never get a reply.
      if (message.id === undefined || message.id === null) continue;

      switch (message.method) {
        case 'initialize':
          result(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
          break;
        case 'tools/list':
          result(message.id, {
            tools: tools.map(({ name: toolName, description, inputSchema }) => ({
              name: toolName,
              description,
              inputSchema,
            })),
          });
          break;
        case 'tools/call':
          void call(message.id, message.params ?? {});
          break;
        case 'ping':
          result(message.id, {});
          break;
        default:
          failure(message.id, -32601, `Method not found: ${message.method}`);
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

/** Read the JSON config handed to a server as its first argument. */
export function configFromArgv() {
  const raw = process.argv[2];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (error) {
    throw new Error(`The server config must be JSON: ${error.message}`, { cause: error });
  }
}
