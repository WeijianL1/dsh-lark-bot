import { describe, expect, it, vi } from 'vitest';
import { HostDshAdapter } from '../../../src/adapters/dsh/host-adapter.js';

function fixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const unsubscribe = vi.fn();
  const returned = vi.fn();
  const controller = {
    create: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    prompt: vi.fn().mockResolvedValue({ accepted: true }),
    cancel: vi.fn().mockResolvedValue({ accepted: true }),
    list: vi.fn().mockResolvedValue({ items: [] }),
    follow: vi.fn((_options: unknown, _signal: AbortSignal) => ({ [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: { type: 'snapshot', cursor: 10,
        records: [{ type: 'event', event: { seq: 10 } }], hasMore: true } }),
      return: async () => { returned(); return { done: true }; },
    }) })),
    page: vi.fn().mockResolvedValue({ records: [{ type: 'event', event: { seq: 5 } }], hasMore: false }),
  };
  const host = { get: () => controller, on: (name: string, fn: (...args: any[]) => void) => {
    listeners.set(name, fn); return () => { listeners.delete(name); unsubscribe(); };
  } };
  const adapter = new HostDshAdapter(host as never, { provider: 'test', model: 'test' });
  return { adapter, controller, returned, unsubscribe, emit: (id: string, event: unknown) => listeners.get('session/event')?.({ id }, event), emitChunk: (text: string) => listeners.get('agent/assistant-stream')?.({ agent: { session: { id: 'session-1' } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } }) };
}

describe('native Host session bridge', () => {
  it('never submits a prompt when stopped during session creation', async () => {
    const { adapter, controller } = fixture();
    let release!: (value: { sessionId: string }) => void;
    controller.create.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const run = adapter.run({ runId: 'early-stop', prompt: 'hello', cwd: '/tmp', sessionId: undefined, model: 'fixture', images: [], stopGraceMs: 500 });
    const stopped = run.stop();
    release({ sessionId: 'session-1' });
    await stopped;
    expect(controller.prompt).not.toHaveBeenCalled();
    expect(controller.cancel).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it('cancels once when stop races with prompt acceptance', async () => {
    const { adapter, controller } = fixture();
    let release!: (value: { accepted: true }) => void;
    controller.prompt.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const run = adapter.run({ runId: 'prompt-stop', prompt: 'hello', cwd: '/tmp', sessionId: undefined, model: 'fixture', images: [], stopGraceMs: 500 });
    await vi.waitFor(() => expect(controller.prompt).toHaveBeenCalledOnce());
    const first = run.stop(), second = run.stop();
    release({ accepted: true });
    await Promise.all([first, second]);
    expect(controller.cancel).toHaveBeenCalledOnce();
    expect(controller.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    await adapter.dispose();
  });

  it('preserves prompt correlation and uses native cancellation', async () => {
    const { adapter, controller } = fixture();
    expect(await adapter.rpc('session.create', { cwd: '/tmp' })).toEqual({ result: { ok: true, value: { sessionId: 'session-1' } } });
    await adapter.rpc('session.prompt', { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }, 'request-1');
    expect(controller.prompt.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ requestId: 'request-1', sessionId: 'session-1' }));
    await adapter.rpc('session.cancel', { sessionId: 'session-1' });
    expect(controller.cancel).toHaveBeenCalledWith({ sessionId: 'session-1' });
    await adapter.dispose();
  });

  it('pages history through the snapshot cursor and closes the subscription', async () => {
    const { adapter, controller, returned } = fixture();
    expect(await adapter.rpc('session.history', { sessionId: 'session-1', beforeSeq: 8, maxMessages: 20 })).toEqual({ result: { ok: true,
      value: { events: [{ type: 'event', event: { seq: 5 } }], hasMore: false } } });
    expect(controller.page.mock.calls[0]?.[0]).toEqual({ address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 10, beforeSeq: 8, maxMessages: 20 });
    expect(returned).toHaveBeenCalledOnce();
    expect(controller.follow.mock.calls[0]?.[1]?.aborted).toBe(true);
    await adapter.dispose();
  });

  it('forwards session events and releases listeners once when disposed', async () => {
    const { adapter, emit, emitChunk, unsubscribe } = fixture();
    const stream = await adapter.openMux();
    const receive = vi.fn();
    stream.addEventListener('message', receive);
    emit('session-1', { type: 'turn/end', seq: 2 });
    expect(JSON.parse(receive.mock.calls[0]?.[0].data)).toEqual({ payload: { type: 'session/event', sessionId: 'session-1', event: { type: 'turn/end', seq: 2 } } });
    emitChunk('Hello');
    expect(JSON.parse(receive.mock.calls[1]?.[0].data).payload.event).toEqual({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Hello' } } });
    await adapter.dispose();
    stream.close();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    emit('session-1', { type: 'turn/end' });
    expect(receive).toHaveBeenCalledTimes(2);
  });
});
