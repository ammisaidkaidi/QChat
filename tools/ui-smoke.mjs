/**
 * End-to-end smoke test for the console, driven by a real browser.
 *
 * Not part of `npm test` because Playwright is a heavy, optional dependency:
 *
 *   npm i -D playwright && npx playwright install --with-deps chromium
 *   npm run build && npm run ui:build && npm run serve   # in one terminal
 *   node tools/ui-smoke.mjs                              # in another
 *
 * It walks the Chat tab through a tool turn and a plain turn, opens the
 * settings drawer (raising a test alert, which must appear as a toast), switches
 * through the Scripts, Skills and MCP tabs (calling a bundled MCP tool from the
 * console), reloads to prove localStorage persistence,
 * and fails on any console error, page error or 4xx/5xx API response.
 * Screenshots and a request log land in ./preview.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env['BASE'] ?? 'http://127.0.0.1:8787';
const OUT = process.env['OUT'] ?? join(ROOT, 'preview');
mkdirSync(OUT, { recursive: true });

const log = [];
const problems = [];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/api/'))
    log.push(`${response.status()} ${response.request().method()} ${url.replace(BASE, '')}`);
});
page.on('requestfailed', (request) => {
  if (request.url().includes('/api/')) problems.push(`requestfailed: ${request.url()}`);
});

const step = async (label, fn) => {
  const started = Date.now();
  await fn();
  console.log(`✔ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
};

/** Send a message and wait for the turn to finish streaming. */
async function ask(text) {
  const before = await page.locator('.chat-start .chat-bubble').count();
  await page.fill('textarea', text);
  await page.click('button:has-text("Send")');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.chat-start .chat-bubble').length > n,
    before,
    { timeout: 240_000 },
  );
  // busy until the Send button replaces the Stop button again
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('Send')),
    undefined,
    { timeout: 240_000 },
  );
  await page.waitForTimeout(400);
  return page.locator('.chat-start .chat-bubble').last().innerText();
}

await step('load the console', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tabs .tab', { timeout: 30_000 });
  await page.waitForFunction(() => !document.body.innerText.includes('checking…'), undefined, {
    timeout: 30_000,
  });
});
console.log(
  '   header:',
  JSON.stringify((await page.locator('.navbar').first().innerText()).split('\n').join(' | ')),
);
await page.screenshot({ path: `${OUT}/01-chat-empty.png` });

await step('first turn (tool call)', async () => {
  const answer = await ask('Use a tool to greet Yacine');
  console.log(`   answer: ${JSON.stringify(answer.split('\n').slice(0, 2).join(' / '))}`);
});
await page.screenshot({ path: `${OUT}/02-chat-tool-turn.png` });

await step('settings drawer', async () => {
  await page.click('button:has-text("Settings")');
  await page.waitForSelector('text=Max new tokens', { timeout: 10_000 });
});
await page.screenshot({ path: `${OUT}/03-chat-settings.png` });

await step('the alert path shows a toast', async () => {
  await page.click('button:has-text("Send a test alert")');
  const toast = page.locator('[data-testid="alert-toast"]', { hasText: 'Test alert' }).first();
  await toast.waitFor({ timeout: 10_000 });
  const text = await toast.innerText();
  console.log(`   toast: ${JSON.stringify(text.split('\n').slice(0, 2).join(' / '))}`);
});
await page.waitForTimeout(250); // let the fixed overlay paint before the shot
await page.screenshot({ path: `${OUT}/11-alert-toast.png` });
await page.locator('button[title="Dismiss this alert"]').first().click();
await page.click('button:has-text("Settings")');

await step('second turn in the same session', async () => {
  const answer = await ask('Which scripts do you have?');
  console.log(`   answer: ${JSON.stringify(answer.split('\n').slice(0, 2).join(' / '))}`);
});
await page.screenshot({ path: `${OUT}/04-chat-follow-up.png` });

await step('copy a response to the clipboard', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Targeted by title: the label itself flips to "Copied" after the click.
  const button = page.locator('button[title="Copy this response"]').last();
  await button.click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.chat-footer button')].some((element) =>
        element.textContent.includes('Copied'),
      ),
    undefined,
    { timeout: 5_000 },
  );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (!clipboard.trim()) throw new Error('the clipboard stayed empty');
  console.log(`   copied ${clipboard.length} chars: ${JSON.stringify(clipboard.slice(0, 60))}`);
});
await page.screenshot({ path: `${OUT}/08-chat-copy.png` });

await step('the header lists the models folder', async () => {
  const selector = page.locator('select[aria-label="Active model"]');
  const options = await selector.locator('option').allInnerTexts();
  console.log(`   options: ${JSON.stringify(options)}`);
  if (!options.some((option) => option.includes('Qwen3-0.6B-Q4_K_M'))) {
    throw new Error('the active model is missing from the picker');
  }
});

await step('third turn (plain knowledge)', async () => {
  const answer = await ask('In one short sentence: what is the capital of Algeria?');
  console.log(`   answer: ${JSON.stringify(answer.split('\n').slice(0, 2).join(' / '))}`);
});

await step('switch to the Scripts tab', async () => {
  await page.click('.tabs .tab:has-text("Scripts")');
  await page.waitForSelector('text=disk_report', { timeout: 15_000 });
});
await page.screenshot({ path: `${OUT}/05-scripts-tab.png` });

await step('switch to the Skills tab', async () => {
  await page.click('.tabs .tab:has-text("Skills")');
  await page.waitForSelector('text=web-research', { timeout: 15_000 });
  const titles = await page.locator('article, .card').filter({ hasText: 'disk-hygiene' }).count();
  if (titles === 0) throw new Error('the bundled skills are missing from the list');
});
await page.screenshot({ path: `${OUT}/09-skills-tab.png` });

await step('switch to the MCP tab and call a tool', async () => {
  await page.click('.tabs .tab:has-text("MCP")');
  await page.waitForSelector('text=example__echo', { timeout: 20_000 });
  const console = page.locator('.card', { hasText: 'Try a tool' }).first();
  await console.locator('input').fill('{"text": "smoke test"}');
  await console.locator('button:has-text("Call")').click();
  await page.waitForSelector('text=✔ ok', { timeout: 20_000 });
  const echoed = await console.locator('pre').innerText();
  if (!echoed.includes('smoke test')) throw new Error(`unexpected MCP result: ${echoed}`);
});
await page.screenshot({ path: `${OUT}/10-mcp-tab.png` });

await step('back to Chat keeps the conversation', async () => {
  await page.click('.tabs .tab:has-text("Chat")');
  await page.waitForSelector('.chat-start .chat-bubble', { timeout: 10_000 });
});
const bubbles = await page.locator('.chat-start .chat-bubble').count();
console.log(`   assistant bubbles after the round trip: ${bubbles}`);
await page.screenshot({ path: `${OUT}/06-chat-persisted.png` });

await step('reload keeps the conversation (localStorage)', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-start .chat-bubble', { timeout: 20_000 });
});
const afterReload = await page.locator('.chat-start .chat-bubble').count();
console.log(`   assistant bubbles after reload: ${afterReload}`);

await step('mobile width', async () => {
  await page.setViewportSize({ width: 420, height: 880 });
  await page.waitForTimeout(400);
});
await page.screenshot({ path: `${OUT}/07-mobile.png` });

writeFileSync(`${OUT}/browser-report.txt`, `${log.join('\n')}\n\n${problems.join('\n')}\n`);
await browser.close();
console.log(log.length > 0 ? `✔ ${log.length} API calls, no 4xx/5xx` : '✘ no API traffic observed');
console.log(
  problems.length === 0
    ? '✔ no console/page errors'
    : `✘ ${problems.length} problems:\n${problems.join('\n')}`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
