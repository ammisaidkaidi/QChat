/**
 * @infagent-script v1
 * @name screen_shot
 * @language js
 * @description Capture the screen (or a web page when there is no display) and save it into ./screenshot/.
 * @callback run(args) -> { ok, result }
 * @usage node scripts/screen_shot.js '{"url":"http://127.0.0.1:8787"}'
 * @params [{"name":"out","type":"string","required":false,"description":"Folder to save into, relative paths resolve against the project root. Defaults to screenshot/."},{"name":"name","type":"string","required":false,"description":"File name. Defaults to shot-<timestamp>.png."},{"name":"url","type":"string","required":false,"description":"Capture this http(s) page instead of the desktop (headless browser)."},{"name":"full","type":"boolean","required":false,"description":"With url: capture the whole page, not just the viewport."},{"name":"width","type":"number","required":false,"description":"With url: viewport width in pixels. Defaults to 1280."},{"name":"height","type":"number","required":false,"description":"With url: viewport height in pixels. Defaults to 900."},{"name":"display","type":"string","required":false,"description":"X11 display to capture, e.g. \":0\". Defaults to $DISPLAY."},{"name":"keep","type":"number","required":false,"description":"How many recent screenshots to keep in the folder. Defaults to 20, 0 disables pruning."}]
 * @agent
 *   Use this script when: the user asks to take, capture or save a screenshot of the screen (or of a web page), or wants a picture of the running InfAgent interface.
 *   Call it with JSON arguments: { "url": <string>, "out": <string>, "name": <string>, "keep": <number> }.
 *   It prints a single JSON envelope on stdout: { "ok": true, "result": { "file", "backend", "width", "height", "bytes" } }.
 *   `backend` says how the picture was taken: x11 (scrot/import), wayland (grim), win32 (PowerShell), xvfb (virtual display), or web (headless browser of `url`).
 *   On failure it prints { "ok": false, "error": "..." } and exits non-zero — read `error` before retrying: no display usually means you must pass a `url`.
 *   Never guess a different name: the script is registered as "screen_shot".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Is this executable on PATH? `sh` does not exist on Windows, so ask `where`. */
function have(binary) {
  const [command, args] =
    process.platform === 'win32' ? ['where', [binary]] : ['sh', ['-c', `command -v ${binary}`]];
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Width/height straight from the PNG header (IHDR), so there is no dependency. */
function pngSize(file) {
  try {
    const buffer = readFileSync(file).subarray(16, 24);
    if (buffer.length < 8) return {};
    return { width: buffer.readUInt32BE(0), height: buffer.readUInt32BE(4) };
  } catch {
    return {};
  }
}

/** A 0.6B model happily passes the doc placeholder (`shot-<timestamp>.png`) as a
 *  real file name; treat anything with angle brackets as "use the default". */
function realValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[<>]/.test(trimmed)) return undefined;
  return trimmed;
}

/** Keep a caller-supplied name inside the folder. */
function safeName(value) {
  return value.replace(/[^\w.-]/g, '_').slice(0, 120);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function prune(folder, keep) {
  if (!keep || keep <= 0) return [];
  const shots = readdirSync(folder)
    .filter((entry) => entry.toLowerCase().endsWith('.png'))
    .map((entry) => ({ entry, time: statSync(join(folder, entry)).mtimeMs }))
    .sort((left, right) => right.time - left.time);

  const removed = [];
  for (const shot of shots.slice(keep)) {
    try {
      unlinkSync(join(folder, shot.entry));
      removed.push(shot.entry);
    } catch {
      // A file that refuses to go is not worth failing the capture over.
    }
  }
  return removed;
}

/**
 * Windows has no X11: PowerShell borrows System.Drawing and grabs the primary
 * screen, which needs no extra install.
 */
function captureWindows(file) {
  const target = file.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$bmp.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()',
  ].join('; ');

  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
  return 'win32';
}

/** Capture the real desktop: Windows first, then Wayland, scrot, ImageMagick. */
function captureScreen(file, display) {
  if (process.platform === 'win32') return captureWindows(file);

  const env = display ? { ...process.env, DISPLAY: display } : process.env;

  if (process.env['WAYLAND_DISPLAY'] && have('grim')) {
    execFileSync('grim', [file], { env, stdio: 'ignore' });
    return 'wayland';
  }

  if (have('scrot')) {
    execFileSync('scrot', ['--overwrite', file], { env, stdio: 'ignore' });
    return 'x11';
  }

  if (have('import')) {
    // `-window root` is the whole screen; ImageMagick is present on most Linux
    // boxes and needs no extra package.
    execFileSync('import', ['-silent', '-window', 'root', file], { env, stdio: 'ignore' });
    return 'x11';
  }

  throw new Error(
    'No screen capture tool found (Linux: install scrot, grim or ImageMagick; Windows: PowerShell must be on PATH).',
  );
}

/** No display? Xvfb gives one to capture from. */
function captureVirtual(file) {
  if (!have('xvfb-run')) {
    throw new Error('No $DISPLAY, and xvfb-run is not installed for a virtual display.');
  }
  execFileSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1280x900x24', 'import', '-silent', '-window', 'root', file],
    { stdio: 'ignore' },
  );
  return 'xvfb';
}

/** Capture a page with the headless browser the console's smoke test already uses. */
async function captureWeb(file, url, options) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error("Capturing a page needs Playwright: npm i -D playwright && npx playwright install chromium (or run with a real $DISPLAY).");
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(options.settleMs ?? 600);
    await page.screenshot({ path: file, fullPage: options.full === true });
  } finally {
    await browser.close();
  }
  return 'web';
}

export async function run(args = {}) {
  const outDir = realValue(args.out) ?? 'screenshot';
  const folder = isAbsolute(outDir) ? outDir : resolve(PROJECT_ROOT, outDir);
  mkdirSync(folder, { recursive: true });

  const requested = realValue(args.name);
  const file = join(
    folder,
    requested
      ? `${safeName(requested.replace(/\.png$/i, ''))}.png`
      : `shot-${stamp()}.png`,
  );
  const url = realValue(args.url) ?? null;

  let backend;
  if (url) {
    backend = await captureWeb(file, url, args);
  } else {
    try {
      backend = captureScreen(file, typeof args.display === 'string' ? args.display : undefined);
    } catch (error) {
      backend = captureVirtual(file);
      if (!existsSync(file)) throw error;
    }
  }

  if (!existsSync(file)) throw new Error(`The capture produced no file at ${file}.`);

  const size = statSync(file);
  const pruned = prune(folder, Number(args.keep ?? 20));

  return {
    file,
    // `path.relative`, because a string replace never matched on Windows.
    relativePath: relative(PROJECT_ROOT, file),
    backend,
    source: url ?? (backend === 'xvfb' ? 'virtual display (no real screen attached)' : 'screen'),
    ...pngSize(file),
    bytes: size.size,
    saved: readdirSync(folder).filter((entry) => entry.toLowerCase().endsWith('.png')).length,
    pruned,
    at: new Date().toISOString(),
  };
}

// Only run the CLI block when this file *is* the program. Importing it (the
// tests do) must never trigger a real capture.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    process.stdout.write(`${JSON.stringify({ ok: true, result: await run(args) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
