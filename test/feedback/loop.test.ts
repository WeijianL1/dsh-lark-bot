import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { FeedbackStore } from '../../src/feedback/store.js';
import { FeedbackTasks, digest } from '../../src/feedback/tasks.js';
import { FeedbackLoop, type FeedbackLoopOptions } from '../../src/feedback/loop.js';
import { screenedCandidates } from '../../src/feedback/screen.js';
import { feedbackCard } from '../../src/feedback/cards.js';
import { feedbackGenerator } from '../../src/feedback/generate.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(memory = false) {
  const root = await mkdtemp(join(tmpdir(), 'feedback-loop-')); roots.push(root);
  const store = new FeedbackStore(join(root, 'feedback'));
  const tasks = new FeedbackTasks(join(root, 'feedback/loop/tasks'));
  const original = await store.create({ chatId: 'chat', chatType: 'group', kind: 'text', text: 'Original answer', origin: { question: 'Original question', workspace: root, threadId: 'thread' } });
  const reason = '以后回答请先给结论，再解释依据';
  const id = digest(`${original.id}:actor:${reason}`);
  await store.mutate(original.id, (r) => {
    r.messageId = r.feedbackMessageId = 'original-message';
    r.votes = [{ actorId: 'actor', actorName: 'Alice', rating: 'down', reason, reasonShared: true, updatedAt: '', ...(memory ? {} : { repairTaskId: id }) }];
  });
  let seq = 0;
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: `reply-${++seq}` } }));
  const generate = vi.fn(async (_system: string, _prompt: string, _signal: AbortSignal) => 'Revised answer');
  const remember = vi.fn(async (_scope: string, key: string, _content: string) => ({ key, result: { id: 'memory-id', action: 'added' } }));
  const recall = vi.fn(async () => 'Persisted scoped preference');
  const authorized = vi.fn(() => true);
  const options: FeedbackLoopOptions = { profile: 'test', repair: !memory, memory, defaultWorkspace: root, store, tasks,
    channel: { rawClient: { im: { v1: { message: { reply } } } } } as unknown as LarkChannel,
    generate, authorized, memoryStore: { remember, recall }, now: () => new Date('2026-09-08T00:00:00Z') };
  return { root, store, tasks, original, reason, id, reply, generate, remember, recall, authorized, options, loop: new FeedbackLoop(options) };
}

describe('feedback loop', () => {
  it('recovers an atomic repair intent, runs once, and binds correction controls to the delivered answer', async () => {
    const f = await fixture();
    await f.loop.tick(); await f.loop.tick();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0]![1]).toContain('Original question');
    expect(f.generate.mock.calls[0]![1]).toContain('Original answer');
    expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'original-message' }, data: expect.objectContaining({ reply_in_thread: true, uuid: f.id.slice(0, 32) }) }));
    const task = (await f.tasks.list())[0]!;
    expect(task).toMatchObject({ state: 'completed', report: 'Revised answer', resultMessageId: 'reply-1' });
    expect(await f.store.read(task.resultFeedbackId!)).toMatchObject({ text: 'Revised answer', messageId: 'reply-1', feedbackMessageId: 'reply-1' });
  });
  it('uses companion controls when a corrected card needs room for a reason form', async () => {
    const f = await fixture();
    f.generate.mockResolvedValueOnce('修正'.repeat(1800));
    await f.loop.tick();
    expect(f.reply).toHaveBeenCalledTimes(2);
    const calls = f.reply.mock.calls as unknown as Array<[{ data: { msg_type: string } }]>;
    expect(calls[0]![0].data.msg_type).toBe('text');
    expect(calls[1]![0].data.msg_type).toBe('interactive');
    const expanded = feedbackCard('id', '字'.repeat(2000), { vote: { actorId: 'actor', actorName: 'Alice', rating: 'down', updatedAt: '', token: 'token', reason: '因'.repeat(1000), reasonShared: true }, up: 0, down: 1, repairEnabled: true });
    expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThan(30_000);
  });
  it('retains earlier screened feedback as support for a later daily lesson', async () => {
    const f = await fixture(true);
    await f.store.mutate(f.original.id, r => { r.votes[0]!.reason = 'The answer omitted citations.'; });
    f.generate.mockResolvedValueOnce('{"candidates":[]}');
    await f.loop.tick();
    expect(f.remember).not.toHaveBeenCalled();
    const second = await f.store.create({ chatId: 'chat', chatType: 'group', kind: 'text', text: 'Another answer', origin: { workspace: f.root } });
    await f.store.mutate(second.id, r => { r.votes = [{ actorId: 'actor', rating: 'down', updatedAt: '', reason: 'Citations were missing again.', reasonShared: true }]; });
    f.options.now = () => new Date('2026-09-09T00:00:00Z');
    f.generate.mockImplementationOnce(async (_sys, prompt) => {
      const evidence = JSON.parse(prompt).evidence;
      expect(evidence).toHaveLength(2);
      return JSON.stringify({ candidates: [{ kind: 'workflow', text: 'Include supporting citations.', sources: evidence.map((e: { key: string }) => e.key) }] });
    });
    await f.loop.tick();
    expect(f.remember).toHaveBeenCalledTimes(1);
    expect((await f.tasks.list()).find(t => t.day === '2026-09-09')!.sourceKeys).toHaveLength(1);
  });
  it('rechecks current access and changed votes before publication', async () => {
    const f = await fixture();
    f.generate.mockImplementationOnce(async () => { f.authorized.mockReturnValue(false); return 'Revised answer'; });
    await f.loop.tick();
    expect(f.reply).not.toHaveBeenCalled();
    expect((await f.tasks.list())[0]!.state).toBe('cancelled');
    const g = await fixture();
    g.generate.mockImplementationOnce(async () => { await g.store.mutate(g.original.id, r => { r.votes[0]!.rating = 'up'; }); return 'Revised'; });
    await g.loop.tick(); expect(g.reply).not.toHaveBeenCalled();
  });
  it('retains generated output on an ambiguous send failure without rerunning the model', async () => {
    const f = await fixture(); f.reply.mockRejectedValueOnce(new Error('timeout'));
    await f.loop.tick(); await f.loop.tick();
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.reply).toHaveBeenCalledTimes(1);
    expect((await f.tasks.list())[0]).toMatchObject({ state: 'failed', report: 'Revised answer', deliveryStartedAt: expect.any(String) });
  });
  it('does not rerun work that was running at process loss', async () => {
    const f = await fixture();
    await f.tasks.enqueue({ id: f.id, kind: 'repair', chatId: 'chat', workspace: f.root, actorId: 'actor', recordId: f.original.id, reasonDigest: digest(f.reason) });
    const task = (await f.tasks.list())[0]!; task.state = 'running'; await f.tasks.save(task);
    await f.loop.tick();
    expect((await f.tasks.list())[0]!.state).toBe('interrupted'); expect(f.generate).not.toHaveBeenCalled();
  });
  it('screens daily evidence, writes actual receipts once, and scopes subsequent recall', async () => {
    const f = await fixture(true);
    f.generate.mockImplementationOnce(async (_sys, prompt) => JSON.stringify({ candidates: [{ kind: 'preference', text: '先给结论，再解释依据。', sources: [JSON.parse(prompt).evidence[0].key] }] }));
    await f.loop.tick(); await f.loop.tick();
    expect(f.remember).toHaveBeenCalledTimes(1);
    expect(f.remember.mock.calls[0]![0]).toBe(JSON.stringify(['test', f.root, 'chat', 'actor']));
    expect((await f.tasks.list())[0]).toMatchObject({ state: 'completed', receipts: [{ key: expect.any(String), result: { id: 'memory-id', action: 'added' } }] });
    await f.loop.memoryContext('chat', f.root, 'other-actor');
    expect(f.recall).toHaveBeenCalledWith(JSON.stringify(['test', f.root, 'chat', 'other-actor']));
  });
  it('defers daily memory processing until 04:00 Shanghai', async () => {
    const f = await fixture(true); f.options.now = () => new Date('2026-09-07T19:59:00Z');
    await f.loop.tick(); expect(f.generate).not.toHaveBeenCalled(); expect(await f.tasks.list()).toHaveLength(0);
  });
  it('does not write a memory if the cited feedback was withdrawn during screening', async () => {
    const f = await fixture(true);
    f.generate.mockImplementationOnce(async (_sys, prompt) => { await f.store.mutate(f.original.id, r => { r.votes[0]!.rating = 'up'; }); return JSON.stringify({ candidates: [{ kind: 'preference', text: '先给结论。', sources: [JSON.parse(prompt).evidence[0].key] }] }); });
    await f.loop.tick(); expect(f.remember).not.toHaveBeenCalled();
  });
});

describe('memory screening gates', () => {
  const evidence = [{ key: 'a', recordId: 'one', reason: 'You always give bad answers.' }, { key: 'b', recordId: 'two', reason: 'bad answer too' }];
  it('rejects invented evidence, isolated complaints, facts and secrets', () => {
    for (const candidate of [
      { kind: 'workflow', text: 'lesson', sources: ['unknown'] },
      { kind: 'preference', text: 'made-up permanent preference', sources: ['a'] },
      { kind: 'fact', text: 'unverified claim', sources: ['a', 'b'] },
      { kind: 'workflow', text: 'password: secret', sources: ['a', 'b'] },
    ]) expect(screenedCandidates(JSON.stringify({ candidates: [candidate] }), evidence)).toEqual([]);
  });
});

describe('tool-less feedback generation', () => {
  it('passes no tools and requires a successful finish', async () => {
    const stream = vi.fn(async function* () { yield { type: 'text-delta', text: 'answer' }; yield { type: 'finish', reason: { kind: 'stop' } }; });
    const generate = feedbackGenerator(() => ({ stream }));
    await expect(generate({ system: 'system', prompt: 'data', provider: 'provider', model: 'model', signal: new AbortController().signal })).resolves.toBe('answer');
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ tools: [], messages: [expect.objectContaining({ role: 'user' })] }));
  });
  it('rejects tool calls without executing anything', async () => {
    const generate = feedbackGenerator(() => ({ stream: async function* () { yield { type: 'tool-call-delta' }; } }));
    await expect(generate({ system: '', prompt: '', provider: 'provider', model: 'model', signal: new AbortController().signal })).rejects.toThrow('cannot execute tools');
  });
});
