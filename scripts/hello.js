/**
 * @infagent-script v1
 * @name hello
 * @language js
 * @description Greet a person by name and report the runtime that executed it.
 * @callback run(args) -> { ok, result }
 * @usage node scripts/hello.js '{"example":true}'
 * @params [{"name":"name","type":"string","required":false,"description":"Who to greet. Defaults to \"world\"."},{"name":"shout","type":"boolean","required":false,"description":"Uppercase the greeting."}]
 * @agent
 *   Use this script when: Greet a person by name and report the runtime that executed it.
 *   Call it with JSON arguments: { "name": <string>, "shout": <boolean> }.
 *   It prints a single JSON envelope on stdout: { "ok": true, "result": ... }.
 *   On failure it prints { "ok": false, "error": "..." } and exits non-zero — check the envelope before retrying.
 *   Never guess a different name: the script is registered as "hello".
 */

export function run({ name = 'world', shout = false } = {}) {
  const greeting = `Hello, ${name}!`;
  return {
    greeting: shout ? greeting.toUpperCase() : greeting,
    node: process.version,
    at: new Date().toISOString(),
  };
}

if (process.argv[1] && import.meta.url.endsWith('hello.js')) {
  try {
    const args = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    process.stdout.write(`${JSON.stringify({ ok: true, result: run(args) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
