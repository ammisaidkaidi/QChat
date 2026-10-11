/**
 * The `screen_shot` script is exercised through its public `run()` function.
 *
 * The desktop backend needs a real display (or xvfb), so the tests drive the
 * `url` path instead against a tiny local page, and are skipped when Playwright
 * is not installed.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The script is plain .js with no types; it is exercised through its run().
// @ts-expect-error — no declaration file for the agent script
import { run } from '../scripts/screen_shot.js';

const hasPlaywright = await import('playwright')
  .then(() => true)
  .catch(() => false);

let server: Server;
let page = '';

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html><head><title>screen shot test</title></head>' +
        '<body style="background:#123456"><h1 style="font:32px sans-serif">capture me</h1></body></html>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  page = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  // Playwright leaves keep-alive sockets behind; without this, close() waits.
  server.closeAllConnections?.();
  await new Promise<void>((done) => server.close(() => done()));
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'infagent-shot-'));
}

describe.skipIf(!hasPlaywright)('screen_shot', () => {
  it('saves a PNG into the requested folder and reports its size', async () => {
    const out = scratch();
    const result = await run({ out, name: 'unit.png', url: page });

    expect(result.backend).toBe('web');
    expect(result.relativePath).toBe(result.file);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(900);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(readdirSync(out)).toEqual(['unit.png']);
  }, 60_000);

  it('defaults the name to a timestamp and ignores a doc placeholder', async () => {
    const out = scratch();
    const generated = await run({ out, url: page });
    expect(generated.file).toMatch(/shot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);

    const placeholder = await run({ out, name: 'shot-<timestamp>.png', url: page });
    expect(placeholder.file).toMatch(/shot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);
    expect(readdirSync(out)).toHaveLength(2);
  }, 90_000);

  it('prunes everything past the keep limit', async () => {
    const out = scratch();
    // Explicit mtimes: "newest" must not depend on how fast the loop ran.
    const base = Date.now() / 1000 - 300;
    ['old-1.png', 'old-2.png', 'old-3.png'].forEach((name, index) => {
      const file = join(out, name);
      writeFileSync(file, 'not really a png');
      utimesSync(file, base + index, base + index);
    });

    const result = await run({ out, name: 'newest.png', url: page, keep: 2 });

    expect(result.pruned).toHaveLength(2);
    expect(result.saved).toBe(2);
    expect(readdirSync(out).sort()).toEqual(['newest.png', 'old-3.png']);
  }, 60_000);

  it('honours the viewport size', async () => {
    const out = scratch();
    const result = await run({ out, name: 'small.png', url: page, width: 640, height: 480 });
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  }, 60_000);

  it('fails loudly when the destination cannot be written', async () => {
    // A file where a directory is expected: mkdir throws immediately instead of
    // probing something exotic (a /proc path can hang inside a container).
    const out = scratch();
    const blocker = join(out, 'not-a-directory');
    writeFileSync(blocker, 'this is a file');

    await expect(run({ out: join(blocker, 'child'), url: page })).rejects.toBeTruthy();
  }, 30_000);
});
