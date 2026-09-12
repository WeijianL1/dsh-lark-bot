import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebDshAdapter } from '../../../src/adapters/dsh/web-adapter.js';

class FakeWebSocket extends EventTarget {
  static latest: FakeWebSocket | undefined;
  constructor(_url: string | URL) {
    super();
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  close(): void { this.dispatchEvent(new Event('close')); }
  emit(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('WebDshAdapter prompt provenance', () => {
  it.each([undefined, 'existing'])('preserves history and identity context for session %s', async (sessionId) => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const prompt = '[Channel context] sender=A\nContinue the conversation using the history below.\nUser B: file.pdf\nCurrent user message:\nRead that file';
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'session.create') return new Response(JSON.stringify({ result: { ok: true, value: { sessionId: 'fresh' } } }));
      calls.push(body.payload.content);
      queueMicrotask(() => FakeWebSocket.latest?.emit({ payload: { type: 'session/event', sessionId: sessionId ?? 'fresh', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } }));
      return new Response(JSON.stringify({ result: { ok: true } }));
    }));
    const adapter = new WebDshAdapter({ provider: 'p', model: 'm' });
    const run = adapter.run({ runId: 'r', prompt, cwd: '/repo', sessionId, model: 'm', images: undefined, stopGraceMs: 1000 });
    for await (const _event of run.events) { /* drain */ }
    expect(calls).toEqual([[{ type: 'text', text: prompt }]]);
    await adapter.dispose();
  });

  it('durably records the request rpcId before sending a Feishu-origin prompt', async () => {
    const order: string[] = [];
    let promptRpcId = '';
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; rpcId: string };
      expect(body.method).toBe('session.prompt');
      promptRpcId = body.rpcId;
      order.push('fetch');
      queueMicrotask(() => FakeWebSocket.latest?.emit({ payload: {
        type: 'session/event', sessionId: 's1',
        event: { type: 'turn/end', seq: 2, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      } }));
      return new Response(JSON.stringify({ result: { ok: true, value: { accepted: true } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const adapter = new WebDshAdapter({ provider: 'p', model: 'm' });
    const observer = vi.fn(async (input: { rpcId: string }) => {
      expect(input.rpcId).toMatch(/^[0-9a-f-]{36}$/u);
      order.push('observer');
    });
    adapter.setPromptObserver(observer);
    const run = adapter.run({
      runId: 'run-1', prompt: 'hello', cwd: '/repo', sessionId: 's1', model: 'm',
      images: undefined, stopGraceMs: 1_000,
      origin: { source: 'feishu', messageId: 'message-1', scope: 'chat-a', workspaceCwd: '/repo' },
    });
    for await (const _event of run.events) { /* drain */ }
    expect(order).toEqual(['observer', 'fetch']);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', rpcId: promptRpcId,
      origin: expect.objectContaining({ messageId: 'message-1', scope: 'chat-a' }),
    }));
    await adapter.dispose();
  });
});

describe('WebDshAdapter resume capability', () => {
  it('declares resumeCapable so the run-flow reuses the native session', async () => {
    const adapter = new WebDshAdapter({ provider: 'p', model: 'm' });
    expect(adapter.resumeCapable).toBe(true);
    expect(adapter.canResume({ cwd: '/repo', sessionId: 's1', model: 'm' })).toBe(true);
    expect(adapter.canResume({
      runtimeKey: 'scope-a\0/repo',
      cwd: '/repo',
      sessionId: 's1',
      provider: 'p',
      model: 'm',
    })).toBe(true);
    await adapter.dispose();
  });

  it('denies resume once the adapter is disposed (bridge shutdown)', async () => {
    const adapter = new WebDshAdapter({ provider: 'p', model: 'm' });
    await adapter.dispose();
    expect(adapter.canResume({ cwd: '/repo', sessionId: 's1', model: 'm' })).toBe(false);
  });
});
