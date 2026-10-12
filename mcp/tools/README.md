# Tool files

Drop a JavaScript file in this folder and the chat can call what it exports.
`mcp/servers/toolbox.mjs` imports every `*.js` / `*.mjs` file here, takes the
**default export**, and registers each entry as an MCP tool named
`toolbox__<name>` — visible to the model the same way the `filesystem`, `sqlite`
and `code` servers' tools are.

```js
// mcp/tools/hello.js  (this folder already has one)
export default [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    callback: ({ who }) => ({ greeting: `Hello ${who}!` }),
  },
];
```

A file may export several tools. `callback` may be `async`; it receives the call's
arguments and a small context (`{ file, tool, log }`). Whatever it returns is sent
to the model as JSON, capped at `max_result_bytes` (64 kB by default). A thrown
error comes back as a failed tool call with its message — the chat shows it and
will not let an invented value stand next to it.

Add or edit a file, then call `toolbox__reload_tools` (or restart the server in
the MCP panel): the new tools are offered from the next message on, no console
restart needed.

## Limits and trust

| | |
| --- | --- |
| Where files may live | This folder only (`root` in `mcp.json`), symlinks resolved, hidden files skipped. |
| Size | ≤ 64 kB per file, ≤ 32 files, ≤ 24 tools. |
| Time | A call is stopped after `timeout_ms` (5 s) — unless the file blocks the event loop, which cannot be interrupted in-process. |
| Names | `lower_case` 2–41 chars, unique, and not one of the server's own (`tool_files`, `reload_tools`). |
| Trust | **A tool file is code you installed, and it runs with this process's privileges.** This is not a sandbox: it can read your files, use the network, and start processes. For code the *model* wrote, use the `code` server (`mcp/servers/code.mjs`), which does sandbox it. |
