#!/usr/bin/env node
/**
 * A tiny MCP server, bundled with InfAgent as a working example and as the
 * fixture the tests drive. It speaks newline-delimited JSON-RPC 2.0 on stdio
 * and needs nothing but Node.
 *
 * Tools
 *   echo(text)          → returns the text unchanged
 *   add(a, b)           → sums two numbers
 *   now()               → current time, ISO and local
 *
 * Point `mcp.json` at any other server the same way:
 *   { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
 */
import process from 'node:process';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the given text unchanged. Useful to test the connection.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo back.' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First addend.' },
        b: { type: 'number', description: 'Second addend.' },
      },
      required: ['a', 'b'],
    },
  },
  {
    name: 'now',
    description: 'Report the current date and time on the machine running the server.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, message, code = -32603) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function text(id, value) {
  return ok(id, { content: [{ type: 'text', text: String(value) }] });
}

function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'infagent-example', version: '0.1.0' },
      });

    case 'notifications/initialized':
      return null;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};

      switch (name) {
        case 'echo':
          return text(id, args.text ?? '');
        case 'add': {
          const a = Number(args.a);
          const b = Number(args.b);
          if (!Number.isFinite(a) || !Number.isFinite(b)) {
            return ok(id, {
              content: [{ type: 'text', text: 'add expects two numbers (a, b).' }],
              isError: true,
            });
          }
          return text(id, a + b);
        }
        case 'now':
          return text(id, new Date().toISOString());
        default:
          return ok(id, {
            content: [{ type: 'text', text: `Unknown tool "${name}".` }],
            isError: true,
          });
      }
    }

    default:
      return id === undefined ? null : fail(id, `Method not found: ${method}`, -32601);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        const response = handle(JSON.parse(line));
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(`example-mcp: ${error.message}\n`);
      }
    }
    newline = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write('example-mcp: ready\n');
