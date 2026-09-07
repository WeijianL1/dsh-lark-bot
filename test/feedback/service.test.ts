import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import { FeedbackService, feedbackAllowed } from '../../src/feedback/service.js';
import { feedbackCard } from '../../src/feedback/cards.js';
import { FeedbackStore } from '../../src/feedback/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(authorized = (_actor: string, _chat: string) => true) {
  const root = await mkdtemp(join(tmpdir(), 'lark-feedback-')); roots.push(root);
  let sequence = 0;
  const send = vi.fn(async () => ({ messageId: `out-${++sequence}` }));
  const create = vi.fn(async () => ({ code: 0, data: { message_id: `dm-${++sequence}` } }));
  const getChatMembers = vi.fn(async () => [{ id: 'ou_one', name: 'Alice' }, { id: 'ou_two', name: 'Bob' }]);
  const raw = { send, getChatMembers, getChatInfo: vi.fn(async () => ({ chatType: 'group' })), rawClient: { im: { v1: { message: { create } } } } } as unknown as LarkChannel;
  const store = new FeedbackStore(join(root, 'feedback'));
  const service = new FeedbackService(raw, store, authorized);
  const record = async () => {
    const files = await readdir(join(root, 'feedback'));
    const file = files.find((name) => name.endsWith('.json'))!;
    return store.read(file.slice(0, -5));
  };
  return { root, raw, send, create, getChatMembers, store, service, channel: service.decorate(), record };
}
function event(id: string, rating = 'up', actor = 'ou_one', messageId = 'out-1', chatId = 'chat-one'): CardActionEvent {
  return { chatId, messageId, operator: { openId: actor }, action: { tag: 'button', value: { cmd: 'feedback-vote', id, rating } } };
}

describe('message feedback', () => {
  it('attaches native callback buttons, persists votes across restart, and deduplicates each user', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'An answer' });
    const record = await f.record();
    const payload = JSON.stringify(f.send.mock.calls);
    expect(payload).toContain('feedback-vote');
    expect(payload).toContain('behaviors');
    await Promise.all(Array.from({ length: 8 }, () => f.service.handle(event(record.id))));
    const restored = new FeedbackStore(join(f.root, 'feedback'));
    expect((await restored.read(record.id)).votes).toHaveLength(1);
    expect((await stat(join(f.root, 'feedback', `${record.id}.json`))).mode & 0o777).toBe(0o600);
  });

  it('atomically records a repair intent with the submitted reason and exact reply origin', async () => {
    const f = await fixture();
    const origin = vi.fn(() => ({ workspace: '/test-workspace', question: 'Question' }));
    const service = new FeedbackService(f.raw, f.store, () => true, { repair: true, origin });
    await service.decorate().send('chat-one', { markdown: 'Answer' }, { replyTo: 'question-id' });
    const record = await f.record();
    expect(origin).toHaveBeenCalledWith('chat-one', 'question-id');
    expect(record.origin?.question).toBe('Question');
    await service.handle(event(record.id, 'down'));
    const vote = (await f.record()).votes[0]!;
    const form = { ...event(record.id), action: { tag: 'button', value: { cmd: 'feedback-reason', id: record.id, token: vote.token }, formValue: { reason: 'Please correct the explanation.' } } };
    expect(JSON.stringify(await service.handle(form))).toContain('修正已排队');
    const saved = (await f.record()).votes[0]!;
    expect(saved).toMatchObject({ reason: 'Please correct the explanation.', reasonShared: true, repairTaskId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await service.handle(form);
    expect((await f.record()).votes[0]!.repairTaskId).toBe(saved.repairTaskId);
  });
  it('updates the same card with selection and an inline form, without sending DMs', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    const result = await f.service.handle(event(id, 'down'));
    expect(result).toMatchObject({ toast: { type: 'success' }, card: { type: 'raw', data: { config: { update_multi: true } } } });
    const payload = JSON.stringify(result);
    expect(payload).toContain('✓ 👎 1');
    expect(payload).toContain('feedback-reason');
    expect(payload).toContain('answer');
    const vote = (await f.record()).votes[0]!;
    await f.service.handle(event(id, 'down'));
    expect(f.create).not.toHaveBeenCalled();
    const form: CardActionEvent = { ...event(id), action: { tag: 'button', value: { cmd: 'feedback-reason', id, token: vote.token }, formValue: { reason: 'The answer is inaccurate' } } };
    expect(await f.service.handle({ ...form, operator: { openId: 'ou_other' } })).toMatchObject({ toast: { type: 'error' } });
    expect(await f.service.handle({ ...form, chatId: 'private-chat' })).toMatchObject({ toast: { type: 'error' } });
    expect(await f.service.handle({ ...form, messageId: 'forged' })).toMatchObject({ toast: { type: 'error' } });
    expect(JSON.stringify(await f.service.handle(form))).toContain('The answer is inaccurate');
    expect((await f.record()).votes[0]?.reason).toBe('The answer is inaccurate');
    const up = JSON.stringify(await f.service.handle(event(id, 'up')));
    expect(up).toContain('✓ 👍 1');
    expect(up).not.toContain('feedback-reason');
    expect(await f.service.handle(form)).toMatchObject({ toast: { type: 'error' } });
    expect((await f.record()).votes[0]?.reason).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('keeps separate votes and accepts each actor’s valid form after another voter clicks', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    await f.service.handle(event(id, 'down'));
    const first = (await f.record()).votes[0]!;
    const second = JSON.stringify(await f.service.handle(event(id, 'up', 'ou_two')));
    expect(second).toContain('Bob');
    expect(second).toContain('✓ 👍 1');
    expect(second).toContain('👎 1');
    const form = { ...event(id), action: { tag: 'button', value: { cmd: 'feedback-reason', id, token: first.token }, formValue: { reason: '<at id=all>test</at>' } } };
    expect(await f.service.handle(form)).toMatchObject({ toast: { type: 'success' } });
    expect((await f.record()).votes).toHaveLength(2);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('does not disclose legacy private reasons, and preserves old inline cards within the byte limit', async () => {
    const f = await fixture();
    // Simulate an inline card created by the earlier preview (24 KB budget).
    const record = await f.store.create({ chatId: 'chat-one', chatType: 'group', kind: 'text', text: '中'.repeat(2450) });
    await f.store.mutate(record.id, (item) => {
      item.messageId = item.feedbackMessageId = 'out-1';
      item.votes.push({ actorId: 'ou_one', rating: 'down', updatedAt: '', token: 'old-token', promptMessageId: 'old-dm', reason: 'previous private reason' });
    });
    const result = await f.service.handle(event(record.id, 'down'));
    expect(JSON.stringify(result)).not.toContain('previous private reason');
    const form = { ...event(record.id), action: { tag: 'button', value: { cmd: 'feedback-reason', id: record.id, token: 'old-token' }, formValue: { reason: '中'.repeat(1000) } } };
    const saved = await f.service.handle(form);
    expect(saved).toMatchObject({ toast: { type: 'success' } });
    expect(Buffer.byteLength(JSON.stringify(saved.card))).toBeLessThan(30_000);
    expect(JSON.stringify(saved)).toContain(record.text);
    expect((await f.store.read(record.id)).votes[0]?.reason).toHaveLength(1000);
    expect(await f.service.handle({ ...form, messageId: 'old-dm', chatId: 'private-chat' })).toMatchObject({ toast: { type: 'error' } });
  });

  it('rotates SDK dedup keys for repeated votes and corrected reason submissions', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    const values = (card: unknown): Record<string, unknown>[] => {
      if (Array.isArray(card)) return card.flatMap(values);
      if (!card || typeof card !== 'object') return [];
      const node = card as Record<string, unknown>;
      return node.type === 'callback' ? [node.value as Record<string, unknown>] : Object.values(node).flatMap(values);
    };
    // The installed SDK clamps serialized action values to 128 chars for dedup.
    const keys = new Set<string>();
    let card: unknown = feedbackCard(id, 'answer');
    for (const rating of ['up', 'down', 'up', 'down', 'down']) {
      const value = values(card).find((v) => v.cmd === 'feedback-vote' && v.rating === rating)!;
      const key = JSON.stringify(value).slice(0, 128);
      expect(keys.has(key)).toBe(false); keys.add(key);
      const result = await f.service.handle({ ...event(id), action: { tag: 'button', value } });
      expect(result).toMatchObject({ toast: { type: 'success' } });
      card = (result.card as { data: unknown }).data;
    }
    for (const reason of ['', 'corrected reason', 'updated reason']) {
      const value = values(card).find((v) => v.cmd === 'feedback-reason')!;
      const key = JSON.stringify(value).slice(0, 128);
      expect(keys.has(key)).toBe(false); keys.add(key);
      const result = await f.service.handle({ ...event(id), action: { tag: 'button', value, formValue: { reason } } });
      expect(result).toMatchObject({ toast: { type: reason ? 'success' : 'error' } });
      card = (result.card as { data: unknown }).data;
    }
    expect((await f.record()).votes[0]?.reason).toBe('updated reason');
  });

  it('uses roster names and never exposes an open_id when name lookup fails', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    const first = JSON.stringify(await f.service.handle(event(id)));
    expect(first).toContain('Alice');
    expect(first).not.toContain('ou_one');
    f.getChatMembers.mockRejectedValueOnce(new Error('name unavailable'));
    const second = JSON.stringify(await f.service.handle(event(id, 'down', 'ou_missing')));
    expect(second).toContain('投票用户');
    expect(second).not.toContain('ou_missing');
    expect((await f.record()).votes).toHaveLength(2);
  });

  it('bounds a stalled name lookup without blocking the vote', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    f.getChatMembers.mockImplementationOnce(() => new Promise(() => {}));
    const result = await f.service.handle(event(id));
    expect(result).toMatchObject({ toast: { type: 'success' } });
    expect(JSON.stringify(result)).toContain('投票用户');
    expect((await f.record()).votes[0]?.rating).toBe('up');
  });

  it('matches Feishu’s 1000 character input ceiling in both rendering and validation', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    const down = JSON.stringify(await f.service.handle(event(id, 'down')));
    expect(down).toContain('"max_length":1000');
    const vote = (await f.record()).votes[0]!;
    const form = { ...event(id), action: { tag: 'button', value: { cmd: 'feedback-reason', id, token: vote.token }, formValue: { reason: 'x'.repeat(1001) } } };
    expect(await f.service.handle(form)).toMatchObject({ toast: { type: 'error' } });
    form.action.formValue.reason = 'x'.repeat(1000);
    expect(await f.service.handle(form)).toMatchObject({ toast: { type: 'success' } });
  });

  it('links file controls to the actual delivered file and preserves its thread', async () => {
    const f = await fixture();
    await f.channel.send('chat-one', { file: { source: Buffer.from('file'), fileName: 'result.txt' } }, { replyTo: 'parent', replyInThread: true });
    expect(f.send).toHaveBeenNthCalledWith(1, 'chat-one', expect.objectContaining({ file: expect.anything() }), { replyTo: 'parent', replyInThread: true });
    expect(f.send).toHaveBeenNthCalledWith(2, 'chat-one', expect.objectContaining({ card: expect.anything() }), { replyTo: 'out-1', replyInThread: true });
    expect(await f.record()).toMatchObject({ kind: 'file', fileName: 'result.txt', messageId: 'out-1', feedbackMessageId: 'out-2' });
    const { id } = await f.record();
    expect(await f.service.handle(event(id, 'up', 'ou_one', 'out-1'))).toMatchObject({ toast: { type: 'error' } });
    expect(await f.service.handle(event(id, 'up', 'ou_one', 'out-2'))).toMatchObject({ toast: { type: 'success' } });
  });

  it('rejects cross-chat, forged ids, missing actors and revoked access', async () => {
    let allowed = true;
    const f = await fixture(() => allowed);
    await f.channel.send('chat-one', { markdown: 'answer' });
    const { id } = await f.record();
    for (const action of [event(id, 'up', 'ou_one', 'out-1', 'other-chat'), event('../escape'), event(id, 'up', '')]) {
      expect(await f.service.handle(action)).toMatchObject({ toast: { type: 'error' } });
    }
    allowed = false;
    expect(await f.service.handle(event(id))).toMatchObject({ toast: { type: 'error' } });
    expect((await f.record()).votes).toHaveLength(0);
  });

  it('does not treat a feedback attachment failure as a failed file delivery', async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error('file delivery failed'));
    await expect(f.channel.send('chat-one', { file: { source: Buffer.from('x'), fileName: 'x' } })).rejects.toThrow('file delivery failed');
    f.send.mockResolvedValueOnce({ messageId: 'file-ok' }).mockRejectedValueOnce(new Error('card failed'));
    await expect(f.channel.send('chat-one', { file: { source: Buffer.from('x'), fileName: 'x' } })).resolves.toEqual({ messageId: 'file-ok' });
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it('leaves control cards and native mention handling intact', async () => {
    const f = await fixture();
    const card = { schema: '2.0', body: { elements: [] } };
    await f.channel.send('chat-one', { card });
    expect(f.send).toHaveBeenLastCalledWith('chat-one', { card }, undefined);
    await f.channel.send('chat-one', { markdown: 'Hello' }, { mentions: [{ key: 'one', openId: 'ou_one' }] });
    expect(f.send).toHaveBeenNthCalledWith(2, 'chat-one', { markdown: 'Hello' }, expect.anything());
  });
  it('keeps oversized multilingual answers native and never builds an oversized transport card', async () => {
    const f = await fixture();
    const text = '中文'.repeat(4000);
    await f.channel.send('chat-one', { markdown: text });
    expect(f.send).toHaveBeenNthCalledWith(1, 'chat-one', { markdown: text }, undefined);
    const calls = f.send.mock.calls as unknown as Array<[string, { card?: object }]>;
    expect(Buffer.byteLength(JSON.stringify(calls[1]![1].card))).toBeLessThan(24_000);
  });

  it('falls back on a definite card format rejection but never retries ambiguous timeouts', async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(Object.assign(new Error('invalid card'), { code: 'format_error' }));
    await expect(f.channel.send('chat-one', { markdown: 'answer' })).resolves.toHaveProperty('messageId');
    expect(f.send).toHaveBeenNthCalledWith(2, 'chat-one', { markdown: 'answer' }, undefined);
    f.send.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'send_timeout' }));
    await expect(f.channel.send('chat-one', { markdown: 'answer' })).rejects.toThrow('timeout');
    expect(f.send).toHaveBeenCalledTimes(4);
  });

  it('enforces both allowlists for groups and retains user access for DMs', () => {
    const access = { allowedUsers: ['ou_one'], allowedChats: ['chat-one'], admins: [] };
    expect(feedbackAllowed(access, true, 'ou_one', 'chat-one', 'group')).toBe(true);
    expect(feedbackAllowed(access, true, 'ou_one', 'revoked-group', 'group')).toBe(false);
    expect(feedbackAllowed(access, true, 'ou_other', 'chat-one', 'group')).toBe(false);
    expect(feedbackAllowed(access, true, 'ou_one', 'private-chat', 'p2p')).toBe(true);
    expect(feedbackAllowed({ allowedUsers: [], allowedChats: [], admins: [] }, true, 'ou_one', 'chat-one', 'group')).toBe(false);
  });

});
