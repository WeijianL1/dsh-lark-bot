import { describe, expect, it } from 'vitest';
import { translateSessionEvent } from '../../../src/adapters/dsh/sdk-translate.js';

const committed = (text: string, step = 1, seq = step * 10) => ({
  type: 'assistant/message', seq, data: { turn: 1, step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 11, outputTokens: 4 },
  },
});
const chunk = (text: string) => ({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } });

describe('committed assistant text is authoritative', () => {
  it.each([
    ['Hello', 'hello world'],
    ['Hello world', 'Hello'],
    ['discarded', ''],
  ])('replaces divergent stream %j with committed %j', (streamed, full) => {
    const tracker = { emitted: new Set<string>() };
    translateSessionEvent(chunk(streamed), tracker);
    const event = committed(full);
    expect(translateSessionEvent(event, tracker)).toEqual([
      { type: 'final_text', content: full },
      { type: 'usage', inputTokens: 11, outputTokens: 4 },
    ]);
    expect(translateSessionEvent(event, tracker)).toEqual([]);
  });

  it('preserves earlier settled steps when a later step is rewritten', () => {
    const tracker = { emitted: new Set<string>() };
    translateSessionEvent(committed('First. '), tracker);
    translateSessionEvent(chunk('Wrong'), tracker);
    expect(translateSessionEvent(committed('Correct.', 2), tracker)[0]).toEqual({
      type: 'final_text', content: 'First. Correct.',
    });
    translateSessionEvent(chunk(' Tail'), tracker);
    expect(translateSessionEvent(committed(' Tail.', 3), tracker)[0]).toEqual({ type: 'text', delta: '.' });
  });

  it('replaces an incomplete attempt with its committed retry in the same step', () => {
    const tracker = { emitted: new Set<string>() };
    const attempt = { type: 'assistant/attempt', seq: 3, data: { turn: 1, step: 1,
      stream: [{ type: 'text-chunks', index: 0, texts: ['incomplete'] }],
    } };
    expect(translateSessionEvent(attempt, tracker)).toEqual([{ type: 'text', delta: 'incomplete' }]);
    expect(translateSessionEvent(committed('Complete.'), tracker)[0]).toEqual({ type: 'final_text', content: 'Complete.' });
  });

  it('does not repeat settled content or usage with a retransmitted step', () => {
    const tracker = { emitted: new Set<string>() };
    translateSessionEvent(committed('Hello'), tracker);
    expect(translateSessionEvent(committed('Hello', 1, 11), tracker)).toEqual([]);
  });

  it('recovers text from both supported attempt stream record shapes', () => {
    const tracker = { emitted: new Set<string>() };
    const events = translateSessionEvent({ type: 'assistant/attempt', seq: 3, data: {
      turn: 1, step: 1, stream: [
        { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello ' } },
        { type: 'text-chunks', index: 1, texts: ['world'] },
      ],
    } }, tracker);
    expect(events).toEqual([{ type: 'text', delta: 'Hello world' }]);
  });
});
