/**
 * Example tool file for the toolbox server (`mcp/servers/toolbox.mjs`).
 *
 * Anything this module exports by default is offered to the chat as a tool:
 *
 *   export default [{ name, description, callback, inputSchema? }]
 *
 * The server imports this file, validates each entry, and registers it as
 * `toolbox__<name>`. The callback runs in the server's process with your
 * privileges — see mcp/tools/README.md for the trust model and the limits.
 */

function words(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export default [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'Name to greet.' } },
      required: ['who'],
    },
    callback: ({ who }) => ({ greeting: `Hello ${who}!` }),
  },
  {
    name: 'word_count',
    description: 'Count the words, characters and lines in a piece of text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to measure.' } },
      required: ['text'],
    },
    // Async callbacks work the same way: the server awaits the promise.
    callback: async ({ text }) => {
      const value = String(text ?? '');
      return {
        words: words(value).length,
        characters: value.length,
        lines: value ? value.split('\n').length : 0,
      };
    },
  },
];
