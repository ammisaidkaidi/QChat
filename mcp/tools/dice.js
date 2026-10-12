/**
 * Dice — a second example tool file, added while the server was running.
 *
 * Call `toolbox__reload_tools` (or restart the server) and `roll` becomes
 * callable in the chat without restarting the console.
 */
export default [
  {
    name: 'roll',
    description: 'Roll dice and return each face plus the total.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'How many dice (1-20, default 2).' },
        sides: { type: 'number', description: 'Faces per die (default 6).' },
      },
    },
    callback: ({ count, sides } = {}) => {
      const dice = Math.min(Math.max(Math.trunc(Number(count) || 2), 1), 20);
      const faces = Math.min(Math.max(Math.trunc(Number(sides) || 6), 2), 1000);
      const rolls = Array.from({ length: dice }, () => 1 + Math.floor(Math.random() * faces));
      return { dice, sides: faces, rolls, total: rolls.reduce((a, b) => a + b, 0) };
    },
  },
];
