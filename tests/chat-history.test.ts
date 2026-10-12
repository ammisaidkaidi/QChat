import { describe, expect, it } from 'vitest';

import { chatHistoryFromTurns } from '../ui/src/chatHistory.js';
import type { ChatTurn } from '../ui/src/types.js';

describe('chatHistoryFromTurns', () => {
  it('keeps user and assistant text in order', () => {
    const turns: ChatTurn[] = [
      { id: 'u', role: 'user', text: 'Find the file', thinking: '', calls: [] },
      { id: 'a', role: 'assistant', text: 'Found it.', thinking: '', calls: [] },
    ];
    expect(chatHistoryFromTurns(turns)).toEqual([
      { role: 'user', content: 'Find the file' },
      { role: 'assistant', content: 'Found it.' },
    ]);
  });

  it('restores saved tool arguments and results for the next turn', () => {
    const turns: ChatTurn[] = [
      { id: 'u', role: 'user', text: 'Read the file', thinking: '', calls: [] },
      {
        id: 'a',
        role: 'assistant',
        text: 'It says hello.',
        thinking: '',
        calls: [
          {
            name: 'filesystem__read_file',
            args: { path: 'README.md' },
            ok: true,
            result: { content: 'hello' },
          },
        ],
      },
    ];
    const history = chatHistoryFromTurns(turns);
    expect(history[1]?.content).toContain('[Tools called in this earlier turn]');
    expect(history[1]?.content).toContain('filesystem__read_file');
    expect(history[1]?.content).toContain('README.md');
    expect(history[1]?.content).toContain('hello');
  });

  it('does not attach an unfinished streaming reply', () => {
    const turns: ChatTurn[] = [
      { id: 'u', role: 'user', text: 'Wait', thinking: '', calls: [] },
      { id: 'a', role: 'assistant', text: 'partial', thinking: '', calls: [], streaming: true },
    ];
    expect(chatHistoryFromTurns(turns)).toEqual([{ role: 'user', content: 'Wait' }]);
  });

  it('bounds a large tool result in the engine history while leaving it intact in the saved turn', () => {
    const result = 'x'.repeat(100_000);
    const turns: ChatTurn[] = [
      {
        id: 'a',
        role: 'assistant',
        text: 'Done.',
        thinking: '',
        calls: [{ name: 'filesystem__read_file', args: {}, result, ok: true }],
      },
    ];
    const history = chatHistoryFromTurns(turns);
    expect(history[0]?.content.length).toBeLessThan(2_000);
    expect(turns[0]?.calls[0]?.result).toBe(result);
  });
});
