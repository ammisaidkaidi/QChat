/**
 * HTTP surface for the agent UI.
 *
 * Serves the Vue interface from `ui/dist` and exposes the built-in script
 * toolbox at `/api/*`. Same origin for UI and API, so the browser never needs
 * an absolute host (works behind any proxy or tunnel).
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { ScriptError, ScriptRegistry } from '../scripts/registry.js';
import type { CreateScriptInput, ScriptLanguage, UpdateScriptInput } from '../scripts/types.js';
import { webFetch, webSearch, WebError } from '../capabilities/search.js';
import { QwenEngine, ChatError } from '../chat/qwen.js';
import { McpManager } from '../mcp/manager.js';
import { asSkillInput, SkillError, SkillRegistry } from '../skills/registry.js';
import { AlertError, asAlertInput } from '../capabilities/alerts.js';
import type { AlertBus } from '../capabilities/alerts.js';
import type { ChatEvent, ChatRequest } from '../chat/types.js';
import { openSse } from './sse.js';
import { VERSION } from '../version.js';

const MAX_BODY_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface ServerOptions {
  /** Registry backing `/api/scripts`. Defaults to `<cwd>/scripts`. */
  registry?: ScriptRegistry;
  /** Skill library backing `/api/skills`. */
  skills?: SkillRegistry;
  /** MCP server pool backing `/api/mcp`. */
  mcp?: McpManager;
  /** Alert bus backing `/api/alerts` — shared with the chat engine. */
  alerts?: AlertBus;
  /** Local model engine backing `/api/chat`. Defaults to a CPU Qwen3 engine. */
  engine?: QwenEngine;
  /** Folder with the built Vue app. Defaults to `<repo>/ui/dist`. */
  uiDir?: string;
  port?: number;
  host?: string;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ScriptError('io', 'Request body too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ScriptError('io', 'Expected a JSON object body.');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ScriptError('io', 'Body is not valid JSON.');
  }
}

/**
 * Where the built interface lives, derived from this module's own URL.
 *
 * `new URL(...).pathname` looks right and is wrong outside POSIX: on Windows it
 * returns `/D:/dev/app/ui/dist` — a leading slash with the drive letter inside —
 * and `path.resolve` then makes `D:\D:\dev\app\ui\dist`, a path that never
 * exists. The server answered "the Vue interface has not been built yet"
 * however often you built it. `fileURLToPath` is the conversion Node provides
 * for exactly this, and it decodes `%20` and friends on the way.
 */
export function resolveUiDir(moduleUrl: string): string {
  return resolve(fileURLToPath(new URL('../../ui/dist/', moduleUrl)));
}

function defaultUiDir(): string {
  // src/server/*.ts and dist/server/*.js are both two levels below the repo root.
  return resolveUiDir(import.meta.url);
}

/**
 * Which file answers a request path: the real file when it lives inside the
 * built interface, otherwise `index.html` so the app can route client-side.
 * `..` — plain or percent-encoded — never escapes `uiDir`, on either platform.
 */
export function staticFileFor(uiDir: string, pathname: string): string {
  const index = join(uiDir, 'index.html');
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: fall back to the raw path instead of guessing.
  }

  const candidate = join(uiDir, decoded.replace(/^[/\\]+/, ''));
  const inside = relative(uiDir, candidate);
  if (inside.startsWith('..') || isAbsolute(inside)) return index;

  try {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* unreadable file: treat it as missing */
  }
  return index;
}

function serveStatic(res: ServerResponse, uiDir: string, pathname: string): void {
  const file = staticFileFor(uiDir, pathname);

  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>InfAgent</title>
       <body style="font:16px/1.6 system-ui;max-width:44rem;margin:12vh auto;padding:0 1.5rem;background:#0f1115;color:#e6e6e6">
       <h1>InfAgent API is running</h1>
       <p>The Vue interface has not been built yet. Run <code>npm run ui:build</code> in the project root, then reload.</p>
       <p>API is live: <a style="color:#7dd3fc" href="/api/health">/api/health</a> · <a style="color:#7dd3fc" href="/api/scripts">/api/scripts</a> · <a style="color:#7dd3fc" href="/api/tools">/api/tools</a></p>
       </body>`,
    );
    return;
  }

  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(file));
}

export function createServer(options: ServerOptions = {}): Server {
  const registry = options.registry ?? new ScriptRegistry();
  const skills = options.skills ?? new SkillRegistry();
  const mcp = options.mcp ?? new McpManager();
  // One alert bus per server: the engine raises on it through showAlert and the
  // interface follows it live at GET /api/alerts/stream.
  const engine =
    options.engine ??
    new QwenEngine({
      registry,
      skills,
      mcp,
      ...(options.alerts ? { alerts: options.alerts } : {}),
    });
  const alerts = options.alerts ?? engine.alerts;
  const uiDir = options.uiDir ?? defaultUiDir();
  registry.ensureRoot();
  skills.ensureRoot();
  // Connect the configured servers in the background: the console reports state,
  // and a slow or broken server never blocks startup.
  void mcp.startEnabled();

  return createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (!pathname.startsWith('/api/')) {
        serveStatic(res, uiDir, pathname === '/' ? '/index.html' : pathname);
        return;
      }

      const segments = pathname.split('/').filter(Boolean); // ['api', 'scripts', name, tail]

      try {
        if (segments[1] === 'health') {
          sendJson(res, 200, {
            ok: true,
            name: 'InfAgent',
            version: VERSION,
            node: process.version,
            scriptsDir: registry.root,
            allowRun:
              !process.env['INFAGENT_ALLOW_RUN'] || process.env['INFAGENT_ALLOW_RUN'] !== '0',
            stats: registry.stats(),
          });
          return;
        }

        if (segments[1] === 'tools') {
          sendJson(res, 200, {
            tools: registry.toolDefinitions(),
            systemPrompt: registry.systemPrompt(),
          });
          return;
        }

        if (segments[1] === 'chat') {
          const sub = segments[2];

          if (sub === 'status' && method === 'GET') {
            sendJson(res, 200, {
              status: engine.status(),
              config: {
                scriptCount: registry.list().length,
                modelsDir: engine.modelsDir,
                contextSize: engine.contextSize,
                threads: engine.threads,
                defaultTemperature: 0.4,
                defaultMaxTokens: 512,
                thinking: false,
                tools: engine.status().toolsAvailable,
              },
            });
            return;
          }

          if (sub === 'model' && segments[3] === 'download' && method === 'POST') {
            const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
            const requested = typeof body['id'] === 'string' ? body['id'] : undefined;
            const sse = openSse(res);
            try {
              await engine.downloadModel(requested);
              sse.send({ type: 'done', status: engine.status() });
            } catch (error) {
              sse.send({
                type: 'error',
                message: error instanceof Error ? error.message : 'Download failed.',
                status: engine.status(),
              });
            } finally {
              sse.close();
            }
            return;
          }

          if (sub === 'model' && method === 'DELETE') {
            await engine.unload();
            sendJson(res, 200, { status: engine.status() });
            return;
          }

          if (sub === 'model' && method === 'GET') {
            sendJson(res, 200, { status: engine.status() });
            return;
          }

          if (sub === 'completions' && method === 'POST') {
            const body = await readBody(req);
            const request = body as unknown as ChatRequest;
            if (!Array.isArray(request.messages) || request.messages.length === 0) {
              sendJson(res, 400, { error: 'Body must include a non-empty `messages` array.' });
              return;
            }

            const controller = new AbortController();
            const sse = openSse(res);
            req.on('close', () => controller.abort());

            // Iterated by hand so the engine's generator can be closed on
            // disconnect: a generator nobody drains never runs its `finally`,
            // which would leave the engine marked busy forever.
            const turn = engine.stream(request, controller.signal)[Symbol.asyncIterator]();
            try {
              for (;;) {
                const step = await turn.next();
                if (step.done) break;
                const event = step.value;
                if (sse.closed) {
                  controller.abort();
                  break;
                }
                sse.send(event, event.type);
              }
            } catch (error) {
              if (!sse.closed) {
                sse.send({
                  type: 'error',
                  message: error instanceof Error ? error.message : 'Generation failed.',
                } satisfies ChatEvent);
              }
            } finally {
              // Abort the model call and let the generator finish its cleanup.
              controller.abort();
              await turn.return?.({ done: true, value: undefined as never });
              sse.close();
            }
            return;
          }

          sendJson(res, 404, { error: `Unknown chat route: ${pathname}` });
          return;
        }

        if (segments[1] === 'search') {
          if (method !== 'GET') {
            sendJson(res, 405, { error: 'Use GET /api/search?q=…' });
            return;
          }
          try {
            const query = url.searchParams.get('q') ?? '';
            const limit = Number(url.searchParams.get('limit') ?? 5);
            const report = await webSearch(query, { limit: Number.isFinite(limit) ? limit : 5 });
            sendJson(res, 200, report);
          } catch (error) {
            const status = error instanceof WebError && error.code === 'disabled' ? 403 : 400;
            sendJson(res, status, {
              error: error instanceof Error ? error.message : 'Search failed.',
            });
          }
          return;
        }

        if (segments[1] === 'web' && segments[2] === 'fetch') {
          if (method !== 'POST') {
            sendJson(res, 405, { error: 'Use POST /api/web/fetch' });
            return;
          }
          try {
            const body = await readBody(req);
            const page = await webFetch(String(body['url'] ?? ''), {
              maxChars: Number(body['maxChars'] ?? 4000) || 4000,
            });
            sendJson(res, 200, page);
          } catch (error) {
            const status = error instanceof WebError && error.code === 'disabled' ? 403 : 400;
            sendJson(res, status, {
              error: error instanceof Error ? error.message : 'Fetch failed.',
            });
          }
          return;
        }

        if (segments[1] === 'skills') {
          const name = segments[2] ? decodeURIComponent(segments[2]) : undefined;

          try {
            if (!name) {
              if (method === 'GET') {
                sendJson(res, 200, skills.summary());
                return;
              }
              if (method === 'POST') {
                const body = await readBody(req);
                sendJson(res, 201, { skill: skills.create(asSkillInput(body)) });
                return;
              }
            } else {
              if (method === 'GET') {
                sendJson(res, 200, { skill: skills.read(name) });
                return;
              }
              if (method === 'PUT') {
                const body = await readBody(req);
                sendJson(res, 200, {
                  skill: skills.update(name, {
                    ...(typeof body['description'] === 'string'
                      ? { description: body['description'] }
                      : {}),
                    ...(typeof body['when'] === 'string' ? { when: body['when'] } : {}),
                    ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
                  }),
                });
                return;
              }
              if (method === 'DELETE') {
                sendJson(res, 200, { removed: skills.remove(name) });
                return;
              }
            }
          } catch (error) {
            const code = error instanceof SkillError ? error.code : 'io';
            const status = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400;
            sendJson(res, status, {
              error: error instanceof Error ? error.message : 'Skill error.',
            });
            return;
          }

          sendJson(res, 404, { error: `Unknown skills route: ${pathname}` });
          return;
        }

        if (segments[1] === 'mcp') {
          const serverName = segments[3] ? decodeURIComponent(segments[3]) : undefined;

          try {
            if (segments.length === 2 && method === 'GET') {
              sendJson(res, 200, mcp.catalogue());
              return;
            }

            if (segments[2] === 'servers' && segments.length === 2 && method === 'POST') {
              const body = await readBody(req);
              const name = String(body['name'] ?? '');
              const command = String(body['command'] ?? '');
              if (!name || !command) {
                sendJson(res, 400, { error: 'A server needs a `name` and a `command`.' });
                return;
              }
              const args = Array.isArray(body['args']) ? body['args'].map(String) : [];
              mcp.addServer(name, {
                command,
                args,
                ...(typeof body['description'] === 'string'
                  ? { description: body['description'] }
                  : {}),
                enabled: body['enabled'] !== false,
              });
              await mcp.start(name);
              sendJson(res, 201, mcp.catalogue());
              return;
            }

            if (segments[2] === 'servers' && serverName) {
              if (method === 'DELETE') {
                await mcp.removeServer(serverName);
                sendJson(res, 200, mcp.catalogue());
                return;
              }
              if (method === 'POST' && segments[4] === 'start') {
                sendJson(res, 200, { server: await mcp.start(serverName) });
                return;
              }
              if (method === 'POST' && segments[4] === 'stop') {
                await mcp.stop(serverName);
                sendJson(res, 200, { server: mcp.status(serverName) });
                return;
              }
            }

            if (segments[2] === 'tools' && method === 'POST') {
              const body = await readBody(req);
              const tool = String(body['tool'] ?? '');
              const args =
                typeof body['args'] === 'object' && body['args'] !== null
                  ? (body['args'] as Record<string, unknown>)
                  : {};
              const called = await mcp.call(tool, args);
              sendJson(res, 200, {
                server: called.server,
                tool: called.tool,
                ok: called.result.ok,
                text: called.result.text,
                content: called.result.content,
                durationMs: called.result.durationMs,
              });
              return;
            }
          } catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : 'MCP error.' });
            return;
          }

          sendJson(res, 404, { error: `Unknown mcp route: ${pathname}` });
          return;
        }

        if (segments[1] === 'alerts') {
          const sub = segments[2];

          if (sub === undefined && method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? 20);
            sendJson(res, 200, {
              count: alerts.size,
              alerts: alerts.list(Number.isFinite(limit) ? limit : 20),
            });
            return;
          }

          if (sub === undefined && method === 'POST') {
            const body = await readBody(req);
            const alert = alerts.raise(asAlertInput(body), String(body['source'] ?? 'api'));
            sendJson(res, 201, { alert });
            return;
          }

          if (sub === undefined && method === 'DELETE') {
            sendJson(res, 200, { removed: alerts.clear() });
            return;
          }

          // Live feed the console listens to: one event per alert, plus an
          // opening event so the client knows the channel is up.
          if (sub === 'stream' && method === 'GET') {
            const sse = openSse(res);
            sse.send({ type: 'ready', count: alerts.size }, 'ready');
            const unsubscribe = alerts.subscribe((alert) => {
              if (sse.closed) return;
              sse.send({ type: 'alert', alert }, 'alert');
            });
            req.on('close', () => {
              unsubscribe();
              sse.close();
            });
            return;
          }

          sendJson(res, 404, { error: `Unknown alerts route: ${pathname}` });
          return;
        }

        if (segments[1] === 'models') {
          // GET /api/models — the catalogue of the models folder
          if (segments.length === 2 && method === 'GET') {
            sendJson(res, 200, engine.models());
            return;
          }

          // PUT /api/models/active — switch model
          if (segments[2] === 'active' && method === 'PUT') {
            const body = await readBody(req);
            const id = typeof body['id'] === 'string' ? body['id'] : '';
            if (!id) {
              sendJson(res, 400, { error: 'Body must include a model `id`.' });
              return;
            }
            try {
              await engine.useModel(id);
              sendJson(res, 200, { ...engine.models(), status: engine.status() });
            } catch (error) {
              sendJson(res, error instanceof ChatError ? 409 : 400, {
                error: error instanceof Error ? error.message : 'Could not switch model.',
              });
            }
            return;
          }

          // POST /api/models/refresh — adopt GGUFs that have no settings yet
          if (segments[2] === 'refresh' && method === 'POST') {
            sendJson(res, 200, engine.models());
            return;
          }

          sendJson(res, 404, { error: `Unknown models route: ${pathname}` });
          return;
        }

        if (segments[1] === 'scripts') {
          const name = segments[2] ? decodeURIComponent(segments[2]) : undefined;
          const tail = segments[3];

          if (!name) {
            if (method === 'GET') {
              sendJson(res, 200, {
                scripts: registry.list(),
                stats: registry.stats(),
                systemPrompt: registry.systemPrompt(),
              });
              return;
            }
            if (method === 'POST') {
              const body = await readBody(req);
              const created = registry.create(body as unknown as CreateScriptInput);
              sendJson(res, 201, { script: created });
              return;
            }
            sendJson(res, 405, { error: 'Method not allowed.' });
            return;
          }

          if (method === 'GET') {
            if (tail === 'prompt') {
              sendJson(res, 200, { prompt: registry.agentPrompt(name) });
              return;
            }
            sendJson(res, 200, { script: registry.read(name) });
            return;
          }

          if (method === 'PATCH' || method === 'PUT') {
            const body = await readBody(req);
            sendJson(res, 200, { script: registry.update(name, body as UpdateScriptInput) });
            return;
          }

          if (method === 'DELETE') {
            sendJson(res, 200, { removed: registry.remove(name) });
            return;
          }

          if (method === 'POST' && tail === 'run') {
            const body = await readBody(req);
            const args = (body['args'] as Record<string, unknown> | undefined) ?? {};
            const result = await registry.run(name, args);
            sendJson(res, result.ok ? 200 : 422, { result });
            return;
          }

          sendJson(res, 405, { error: `Method ${method} not allowed on /api/scripts/${name}.` });
          return;
        }

        sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
      } catch (error) {
        if (error instanceof ChatError) {
          const status = error.code === 'busy' ? 429 : error.code === 'unavailable' ? 503 : 409;
          sendJson(res, status, { error: error.message, code: error.code });
          return;
        }
        if (
          error instanceof AlertError ||
          (error instanceof WebError && error.code === 'blocked')
        ) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        if (error instanceof ScriptError) {
          const status =
            error.code === 'not_found'
              ? 404
              : error.code === 'exists'
                ? 409
                : error.code === 'disabled'
                  ? 403
                  : 400;
          sendJson(res, status, { error: error.message, code: error.code });
          return;
        }
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unexpected error.' });
      }
    })();
  });
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? Number(process.env['PORT'] ?? 8787);
  const host = options.host ?? process.env['HOST'] ?? '0.0.0.0';
  const server = createServer(options);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export type { ScriptLanguage };
