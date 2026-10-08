import { describe, expect, it } from 'vitest';
import { sdkLaunchOptions } from '../../../src/adapters/dsh/sdk-adapter.js';
import { translateSessionEvent } from '../../../src/adapters/dsh/sdk-translate.js';

describe('DSH 0.2 runtime contract', () => {
  it('emits committed SDK answers and usage without duplicating live Host chunks', () => {
    const event = { type: 'assistant/message', seq: 3, data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }, { type: 'reasoning', text: 'Think' }] },
      usage: { inputTokens: 12, outputTokens: 3 },
    } };
    const tracker = { emitted: new Set<string>() };
    expect(translateSessionEvent(event, tracker)).toEqual([
      { type: 'text', delta: 'Hello world' }, { type: 'thinking', delta: 'Think' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
    ]);
    expect(translateSessionEvent(event, tracker)).toEqual([]);
    const live = { emitted: new Set<string>() };
    translateSessionEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Hello ' } } }, live);
    translateSessionEvent({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'Think' } } }, live);
    expect(translateSessionEvent(event, live)).toEqual([
      { type: 'text', delta: 'world' }, { type: 'usage', inputTokens: 12, outputTokens: 3 },
    ]);
    expect(translateSessionEvent({ ...event, seq: 4, data: { ...event.data, step: 2 } }, live)[0]).toEqual({ type: 'text', delta: 'Hello world' });
  });

  it('reads first-class tool result messages', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { message: {
      role: 'tool', toolCallId: 'call-1', isError: true,
      content: [{ type: 'text', text: 'Permission denied' }],
    } } }, { emitted: new Set() })).toEqual([{ type: 'tool_result', id: 'call-1', output: 'Permission denied', isError: true }]);
  });

  it('retains launch profile, patches and home and rejects unsupported commands', () => {
    expect(sdkLaunchOptions({ command: 'node', args: ['/opt/dsh.js', '--profile', 'web', '--patch', '/tmp/patch.yml', '--home', '/tmp/home'], profile: 'sdk' })).toEqual({ dshBin: '/opt/dsh.js', profile: 'web', patches: ['/tmp/patch.yml'], dshHome: '/tmp/home' });
    expect(sdkLaunchOptions({ command: 'node', args: ['--profile', 'sdk'], profile: 'sdk' })).toEqual({ profile: 'sdk' });
    expect(() => sdkLaunchOptions({ command: 'custom-wrapper', args: [], profile: 'sdk' })).toThrow(/arbitrary command/);
    expect(() => sdkLaunchOptions({ command: 'node', args: ['/opt/dsh.js', '--unknown', 'x'], profile: 'sdk' })).toThrow(/Unsupported/);
  });
});
