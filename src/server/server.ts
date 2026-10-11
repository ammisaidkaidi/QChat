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
import { extname, join, normalize, resolve } from 'node:path';
import process from 'node:process';

import { ScriptError, ScriptRegistry } from '../scripts/registry.js';
import type { CreateScriptInput, ScriptLanguage, UpdateScriptInput } from '../scripts/types.js';
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

function defaultUiDir(): string {
  // src/server/*.ts and dist/server/*.js are both two levels below the repo root.
  return resolve(new URL('../../ui/dist', import.meta.url).pathname);
}

function serveStatic(res: ServerResponse, uiDir: string, pathname: string): void {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(uiDir, safePath);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html');

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
  const uiDir = options.uiDir ?? defaultUiDir();
  registry.ensureRoot();

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
