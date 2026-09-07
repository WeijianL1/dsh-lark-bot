import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { LearningJournal, type ConversationEvidence } from '../../src/learning/journal.js';
import { FeedbackLoop, type FeedbackLoopOptions } from '../../src/feedback/loop.js';
import { FeedbackStore } from '../../src/feedback/store.js';
import { FeedbackTasks } from '../../src/feedback/tasks.js';
import { screenedCandidates } from '../../src/feedback/screen.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conversation-learning-')); dirs.push(root);
  const learning = new LearningJournal(join(root, 'learning'));
  const tasks = new FeedbackTasks(join(root, 'tasks'));
  let now = Date.now();
  const generate = vi.fn(async (_sys: string, prompt: string) => {
    const evidence = JSON.parse(prompt).evidence;
    return JSON.stringify({ candidates: [{ kind: 'preference', text: 'Start with the conclusion.', sources: [evidence[0].key], quotes: [evidence[0].reason] }] });
  });
  const remember = vi.fn(async (_scope: string, key: string, _text: string) => ({ key, result: { id: 'native-id', store: 'store' } }));
  const forget = vi.fn(async () => {});
  const recall = vi.fn(async () => 'Scoped memory');
  const authorized = vi.fn(() => true);
  const options: FeedbackLoopOptions = { profile: 'profile', repair: false, memory: true, conversations: true, learning, tasks,
    store: new FeedbackStore(join(root, 'votes')), defaultWorkspace: root, channel: {} as LarkChannel, generate,
    memoryStore: { remember, forget, recall }, authorized, now: () => new Date(now) };
  const loop = new FeedbackLoop(options);
  const input: Omit<ConversationEvidence, 'key' | 'recordId'> = { sessionId: 'session', messageId: 'message', chatId: 'chat', chatType: 'group', actorId: 'alice', workspace: root, transport: 'feishu', reason: '以后请先给结论。', createdAt: now };
  return { loop, learning, tasks, generate, remember, forget, recall, authorized, input, options, advance: (ms: number) => { now += ms; } };
}
it('waits for idle, persists only once, and recalls within the actor/chat/workspace scope', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); await f.loop.observeConversation(f.input);
  expect(await f.learning.list()).toHaveLength(1);
  await f.loop.tick(); expect(f.generate).not.toHaveBeenCalled();
  f.advance(121000); await f.loop.tick(); await f.loop.tick();
  expect(f.remember).toHaveBeenCalledTimes(1);
  expect(f.remember.mock.calls[0]![0]).toBe(JSON.stringify(['profile', f.input.workspace, 'chat', 'alice']));
  await f.loop.memoryContext('chat', f.input.workspace, 'bob');
  expect(f.recall).toHaveBeenCalledWith(JSON.stringify(['profile', f.input.workspace, 'chat', 'bob']));
  expect((await f.tasks.list())[0]).toMatchObject({ state: 'completed', conversationBatch: true, receipts: [expect.any(Object)] });
});
it('rejects one-off instructions, invented quotations and praise as permanent preferences', () => {
  for (const reason of ['这次请先给结论，以后再说。', '好的，谢谢', 'Just this time, always include a table']) {
    expect(screenedCandidates(JSON.stringify({ candidates: [{ kind: 'preference', text: 'Always use a table', sources: ['a'], quotes: [reason] }] }), [{ key: 'a', recordId: 'a', reason, source: 'conversation' }])).toEqual([]);
  }
  expect(screenedCandidates(JSON.stringify({ candidates: [{ kind: 'preference', text: 'Use tables', sources: ['a'], quotes: ['fabricated quote'] }] }), [{ key: 'a', recordId: 'a', reason: '以后请先给结论。', source: 'conversation' }])).toEqual([]);
});
it('rechecks actor access before writing and does not publish an extra answer', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); f.advance(121000);
  f.generate.mockImplementationOnce(async (_sys, prompt) => { f.authorized.mockReturnValue(false); const e = JSON.parse(prompt).evidence[0]; return JSON.stringify({ candidates: [{ kind: 'preference', text: 'Conclusion first', sources: [e.key], quotes: [e.reason] }] }); });
  await f.loop.tick(); expect(f.remember).not.toHaveBeenCalled();
});
it('cancels a stale review when further chat arrives during generation', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); f.advance(121000);
  f.generate.mockImplementationOnce(async (_sys, prompt) => { await f.loop.observeConversation({ ...f.input, messageId: 'later', reason: '不对，以后请先列证据。', createdAt: f.input.createdAt + 121000 }); const e = JSON.parse(prompt).evidence[0]; return JSON.stringify({ candidates: [{ kind: 'preference', text: 'Conclusion first', sources: [e.key], quotes: [e.reason] }] }); });
  await f.loop.tick(); expect(f.remember).not.toHaveBeenCalled(); expect((await f.tasks.list())[0]!.state).toBe('cancelled');
});
it('replaces an explicitly corrected lesson with native retirement and preserved provenance', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); f.advance(121000); await f.loop.tick();
  const scope = JSON.stringify(['profile', f.input.workspace, 'chat', 'alice']); const old = (await f.learning.lessons(scope))[0]!;
  await f.loop.observeConversation({ ...f.input, messageId: 'later', reason: '以后改为先列证据，再给结论。', createdAt: f.input.createdAt + 122000 });
  f.advance(600000);
  f.generate.mockImplementationOnce(async (_sys, prompt) => { const e = JSON.parse(prompt).evidence.find((e: { reason: string }) => e.reason.includes('改为')); return JSON.stringify({ candidates: [{ kind: 'preference', text: 'Evidence before conclusions.', sources: [e.key], quotes: [e.reason], supersedes: [old.key] }] }); });
  await f.loop.tick(); expect(f.forget).toHaveBeenCalledWith(scope, old.receipt);
  const lessons = await f.learning.lessons(scope); expect(lessons).toHaveLength(2); expect(lessons[0]!.supersededBy).toBe(lessons[1]!.key);
});
it('reschedules a full 20-message batch after a 21st message arrives', async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) await f.loop.observeConversation({ ...f.input, messageId: `m-${i}` });
  f.advance(121000);
  f.generate.mockImplementationOnce(async () => { await f.loop.observeConversation({ ...f.input, messageId: 'm-21', createdAt: f.input.createdAt + 121000 }); return '{"candidates":[]}'; });
  await f.loop.tick(); expect((await f.tasks.list())[0]!.state).toBe('cancelled');
  f.advance(600000); await f.loop.tick();
  expect(await f.tasks.list()).toHaveLength(2); expect(f.remember).toHaveBeenCalledTimes(1);
});
it('recovers pending native retirement without repeating model generation', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); f.advance(121000); await f.loop.tick();
  const scope = JSON.stringify(['profile', f.input.workspace, 'chat', 'alice']); const old = (await f.learning.lessons(scope))[0]!;
  await f.loop.observeConversation({ ...f.input, messageId: 'later', reason: '以后改为先列证据。', createdAt: f.input.createdAt + 122000 }); f.advance(600000);
  f.generate.mockImplementationOnce(async (_sys, prompt) => { const e = JSON.parse(prompt).evidence.find((e: { reason: string }) => e.reason.includes('改为')); return JSON.stringify({ candidates: [{ kind: 'preference', text: 'Evidence first.', sources: [e.key], quotes: [e.reason], supersedes: [old.key] }] }); });
  f.forget.mockRejectedValueOnce(new Error('CLI unavailable'));
  await f.loop.tick(); expect((await f.learning.lessons(scope))[0]!.pendingSupersededBy).toBeDefined();
  await f.loop.memoryContext('chat', f.input.workspace, 'alice'); expect(f.recall).toHaveBeenLastCalledWith(scope, [old.key]);
  const restarted = new FeedbackLoop(f.options); await restarted.tick();
  expect((await f.learning.lessons(scope))[0]!.supersededBy).toBeDefined(); expect(f.generate).toHaveBeenCalledTimes(2);
});
it('reactivates A after A to B to A and retains earlier receipt history', async () => {
  const f = await fixture(); await f.loop.observeConversation(f.input); f.advance(121000); await f.loop.tick();
  const scope = JSON.stringify(['profile', f.input.workspace, 'chat', 'alice']); const first = (await f.learning.lessons(scope))[0]!;
  for (const [index, text] of ['Evidence first.', 'Start with the conclusion.'].entries()) {
    const active = (await f.learning.lessons(scope)).find(item => !item.supersededBy)!;
    await f.loop.observeConversation({ ...f.input, messageId: `change-${index}`, reason: `以后改为${text}`, createdAt: f.input.createdAt + 122000 + index }); f.advance(600000);
    f.generate.mockImplementationOnce(async (_sys, prompt) => { const e = JSON.parse(prompt).evidence.find((e: { reason: string }) => e.reason === `以后改为${text}`); return JSON.stringify({ candidates: [{ kind: 'preference', text, sources: [e.key], quotes: [e.reason], supersedes: [active.key] }] }); });
    await f.loop.tick();
  }
  const active = (await f.learning.lessons(scope)).filter(item => !item.supersededBy); expect(active).toHaveLength(1); expect(active[0]!.key).toBe(first.key); expect(active[0]!.revisions).toHaveLength(1);
});
