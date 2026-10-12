/**
 * @infagent-script v1
 * @name log
 * @language js
 * @description Created through chat.
 * @callback run(args) -> { ok, result }
 * @usage node scripts/log.js '{"example":true}'
 * @params []
 * @agent
 *   Use this script when: Created through chat.
 *   Call it with JSON arguments: { /* no parameters *\/ }.
 *   It prints a single JSON envelope on stdout: { "ok": true, "result": ... }.
 *   On failure it prints { "ok": false, "error": "..." } and exits non-zero — check the envelope before retrying.
 *   Never guess a different name: the script is registered as "log".
 */

import { pathToFileURL } from 'node:url';

/**
 * Created through chat.
 */
export function run(args = {}) {
  // TODO: implement the script logic here.
  return { echo: args };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let payload = {};
  try {
    payload = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    process.stdout.write(`${JSON.stringify({ ok: true, result: run(payload) })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
