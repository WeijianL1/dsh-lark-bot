import { Context, Service } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { attachConversationLearning, type ConversationLearningPort } from '../../src/learning/host.js';
function fixture() {
  const listeners = new Map<string, (...args: any[]) => any>();
  const session = { id: 'session', header: { cwd: '/project' } };
  const agent = { id: 'session', session, ctx: { on: (name: string, fn: (...args: any[]) => any) => { listeners.set(name, fn); return () => listeners.delete(name); } } };
  const context = { inject: (_names: string[], callback: (ctx: unknown) => unknown) => { callback({ agents: { roots: () => [agent] }, on: () => () => {} }); return { dispose: async () => {} }; } } as unknown as Context;
  const port: ConversationLearningPort = { resolve: vi.fn((_session, workspace, rpc) => rpc === 'foreign' ? undefined : ({ workspace, chatId: rpc === 'lark' ? 'chat' : 'local-web', chatType: 'p2p' as const, actorId: 'alice', transport: rpc === 'lark' ? 'feishu' as const : 'local' as const, ...(rpc === 'lark' ? { originalText: '以后请先给结论。' } : {}) })), observe: vi.fn(async () => {}), recall: vi.fn(async () => 'Prior scoped lesson'), activity: vi.fn() };
  const stop = attachConversationLearning(context, port);
  const step = (messages: any[]) => listeners.get('agent/pre-step')!({ step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));
  const event = (type: string, data = {}) => listeners.get('session/event')!(session, { type, data });
  return { port, stop, step, event };
}
const message = (id: string, rpcId = 'web', kind = 'user') => ({ id, role: 'user', source: { kind, rpcId }, content: [{ type: 'text', text: '以后请用简洁的回答。' }] });
it('captures only trusted human text at completed turns and injects local memories as plugin context', async () => {
  const f = fixture(); const decision = await f.step([message('one'), message('plugin', 'web', 'plugin'), message('foreign', 'foreign')]);
  expect(decision.messages.at(-1).source).toMatchObject({ kind: 'plugin', form: 'recall' });
  expect(f.port.observe).not.toHaveBeenCalled();
  f.event('assistant/message', { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Prior answer' }] } });
  f.event('turn/end'); await Promise.resolve(); await Promise.resolve();
  await f.step([message('two')]); f.event('turn/end'); await f.stop();
  expect(f.port.observe).toHaveBeenCalledTimes(2);
  expect(f.port.observe).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'two', answer: 'Prior answer', transport: 'local' }));
});
it('uses the exact transport receipt instead of the wrapped Lark prompt and does not recall twice', async () => {
  const f = fixture(); await f.step([message('one', 'lark')]); f.event('turn/end'); await f.stop();
  expect(f.port.observe).toHaveBeenCalledWith(expect.objectContaining({ reason: '以后请先给结论。', chatId: 'chat', actorId: 'alice', transport: 'feishu' }));
  expect(f.port.recall).not.toHaveBeenCalled();
});
it('does not capture an unfinished turn or learn from its own injected memories', async () => {
  const f = fixture(); await f.step([message('one', 'web', 'plugin')]); await f.stop(); expect(f.port.observe).not.toHaveBeenCalled();
});

it('reinstalls same-ID agents after the actual Cordis registry service is reloaded', async () => {
  const root = new Context();
  const on = vi.fn(() => vi.fn());
  const agent = { id: 'same-id', session: { id: 'same-id', header: { cwd: '/project' } }, ctx: { on } };
  class Registry extends Service {
    constructor(ctx: Context) { super(ctx, 'agents'); }
    roots() { return [agent]; }
  }
  try {
    let provider = root.plugin(Registry); await provider;
    await root.plugin(ctx => attachConversationLearning(ctx, { resolve: () => undefined, observe: async () => {}, recall: async () => '', activity: () => {} }));
    expect(on).toHaveBeenCalledTimes(3);
    await provider.dispose(); provider = root.plugin(Registry); await provider;
    expect(on).toHaveBeenCalledTimes(6);
  } finally { await root.fiber.dispose(); }
});
