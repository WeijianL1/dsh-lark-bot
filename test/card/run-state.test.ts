import { describe, expect, it } from 'vitest';
import {
  initialState,
  markInterrupted,
  reduce,
} from '../../src/card/run-state.js';

describe('run state reducer', () => {
  it('totals every step in a turn and starts the next run at zero', () => {
    let state = reduce(initialState, { type: 'usage', inputTokens: 100, outputTokens: 20 });
    state = reduce(state, { type: 'tool_use', id: 'a', name: 'read', input: {} });
    state = reduce(state, { type: 'tool_result', id: 'a', output: 'ok', isError: false });
    state = reduce(state, { type: 'usage', inputTokens: 150, outputTokens: 30 });
    state = reduce(state, { type: 'done', sessionId: 'same-session', terminationReason: 'normal' });
    expect(state.usage).toEqual({ inputTokens: 250, outputTokens: 50 });
    const next = reduce(initialState, { type: 'usage', inputTokens: 10, outputTokens: 2 });
    expect(next.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(initialState.usage).toBeUndefined();
  });

  it('preserves known totals for missing fields and ignores context snapshots', () => {
    let state = reduce(initialState, { type: 'usage', inputTokens: 100 });
    expect(state.usage?.outputTokens).toBeUndefined();
    state = reduce(state, { type: 'usage', outputTokens: 0 });
    state = reduce(state, { type: 'usage', outputTokens: 25 });
    state = reduce(state, { type: 'context_usage', usedTokens: 900, contextWindow: 1000 });
    state = markInterrupted(state);
    expect(state.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
  });

  it('streams text deltas into the same block', () => {
    const state = reduce(
      reduce(initialState, { type: 'text', delta: 'hello' }),
      { type: 'text', delta: ' world' },
    );

    expect(state.blocks).toEqual([
      { kind: 'text', content: 'hello world', streaming: true },
    ]);
    expect(state.footer).toBe('streaming');
  });

  it('marks interrupted runs as terminal', () => {
    const state = markInterrupted(
      reduce(initialState, { type: 'text', delta: 'partial' }),
    );

    expect(state.terminal).toBe('interrupted');
    expect(state.footer).toBeNull();
  });

  it('renders committed final text even when no streaming deltas were emitted', () => {
    const state = reduce(initialState, {
      type: 'final_text',
      content: 'hello from dsh',
    });

    expect(state.blocks).toEqual([
      { kind: 'text', content: 'hello from dsh', streaming: false },
    ]);
  });

  it('coalesces repeated updates for the same tool call', () => {
    let state = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read',
      input: '',
    });
    state = reduce(state, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read',
      input: { path: 'src/index.ts' },
    });
    state = reduce(state, {
      type: 'tool_result',
      id: 'tool-1',
      output: 'file contents',
      isError: false,
    });
    state = reduce(state, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'src/index.ts' },
    });

    expect(state.blocks).toEqual([
      {
        kind: 'tool',
        tool: {
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'src/index.ts' },
          status: 'done',
          output: 'file contents',
        },
      },
    ]);
    expect(state.footer).toBe('thinking');
  });
});
