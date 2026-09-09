import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmartIntervention } from '../../src/bridge/smart-intervention.js';
function input(id: string, text = '有人知道这个问题怎么解决吗？', scope = 'group:user') {
  return { scope, workspace: '/workspace', message: { messageId: id, chatId: 'group', senderId: scope,
    senderType: 'user', content: text, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [] } as unknown as NormalizedMessage };
}
function setup(generate = vi.fn().mockResolvedValue('{"reply":"可以先确认输入条件，再逐步排查。"}')) {
  const send = vi.fn().mockResolvedValue(undefined); const authorized = vi.fn().mockReturnValue(true); const busy = vi.fn().mockReturnValue(false);
  const bot = new SmartIntervention({ chats: ['group'], cooldownMs: 180_000, generate, send, authorized, busy });
  return { bot, generate, send, authorized, busy };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.useRealTimers(); });
describe('smart group intervention', () => {
  it('stays silent for acknowledgements, past history, attachments and model silence', async () => {
    const h = setup(vi.fn().mockResolvedValue('{"reply":null}'));
    h.bot.observe(input('ack', '谢谢'), false);
    const past = input('past'); past.message.createTime--; h.bot.observe(past, false);
    const file = input('file'); file.message.resources = [{ type: 'file', fileKey: 'file' }]; h.bot.observe(file, false);
    await vi.advanceTimersByTimeAsync(5000); expect(h.generate).not.toHaveBeenCalled();
    h.bot.observe(input('question'), false); await vi.advanceTimersByTimeAsync(5000);
    expect(h.generate).toHaveBeenCalledOnce(); expect(h.send).not.toHaveBeenCalled(); h.bot.stop();
  });
  it('debounces, deduplicates, and shares reply cooldown across a group', async () => {
    const h = setup();
    h.bot.observe(input('a', '这是背景'), false); await vi.advanceTimersByTimeAsync(2000);
    h.bot.observe(input('b'), false); h.bot.observe(input('b'), false); await vi.advanceTimersByTimeAsync(4000);
    expect(h.generate).toHaveBeenCalledOnce(); expect(h.send).toHaveBeenCalledOnce();
    h.bot.observe(input('c', '再一个问题？', 'group:other-thread'), false); await vi.advanceTimersByTimeAsync(5000);
    expect(h.generate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180000); h.bot.observe(input('d'), false); await vi.advanceTimersByTimeAsync(4000);
    expect(h.generate).toHaveBeenCalledTimes(2); expect(h.send).toHaveBeenCalledOnce(); h.bot.stop();
  });
  it('cancels outdated or directed replies and rechecks authorization', async () => {
    let resolve!: (value: string) => void;
    const h = setup(vi.fn(() => new Promise<string>((done) => { resolve = done; })));
    h.bot.observe(input('a'), false); await vi.advanceTimersByTimeAsync(4000);
    h.bot.observe(input('at', '请帮我查询'), true); resolve('{"reply":"stale"}');
    await vi.advanceTimersByTimeAsync(1); expect(h.send).not.toHaveBeenCalled();
    expect(h.generate.mock.calls[0]?.[2].aborted).toBe(true);
    h.bot.stop();
    const revoked = setup(); revoked.bot.observe(input('b'), false); revoked.authorized.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000); expect(revoked.generate).not.toHaveBeenCalled(); revoked.bot.stop();
  });
  it('does not mix member/workspace histories or start while an agent is busy', async () => {
    const h = setup(); h.busy.mockReturnValue(true); h.bot.observe(input('busy'), false);
    await vi.advanceTimersByTimeAsync(5000); expect(h.generate).not.toHaveBeenCalled();
    h.busy.mockReturnValue(false); h.bot.observe(input('other', '第二位用户的问题？', 'group:other'), false);
    await vi.advanceTimersByTimeAsync(4000);
    const prompt = h.generate.mock.calls[0]?.[1]; expect(prompt).toContain('第二位用户'); expect(prompt).not.toContain('有人知道'); h.bot.stop();
  });
  it.each(['not json', '{"reply":"<at id=all>all</at>"}', '{"reply":"text","tools":[]}'])('silently rejects invalid model output: %s', async (raw) => {
    const h = setup(vi.fn().mockResolvedValue(raw)); h.bot.observe(input('q'), false);
    await vi.advanceTimersByTimeAsync(4000); expect(h.send).not.toHaveBeenCalled(); h.bot.stop();
  });
  it('times out a stalled judge and stops without sending', async () => {
    const h = setup(vi.fn(() => new Promise<string>(() => {})));
    h.bot.observe(input('q'), false); await vi.advanceTimersByTimeAsync(34000);
    expect(h.generate.mock.calls[0]?.[2].aborted).toBe(true); expect(h.send).not.toHaveBeenCalled(); h.bot.stop();
  });
  it('expires public context and keeps it scoped to a workspace/member', async () => {
    const h = setup(); h.bot.observe(input('a', 'first member public context'), false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.bot.contextFor('group:user', '/workspace')).toContain('first member');
    expect(h.bot.contextFor('group:other', '/workspace')).toBe('');
    expect(h.bot.contextFor('group:user', '/other-workspace')).toBe('');
    await vi.advanceTimersByTimeAsync(600001);
    expect(h.bot.contextFor('group:user', '/workspace')).toBe('[]'); h.bot.stop();
  });
  it('drops a reply that becomes stale during generation', async () => {
    let resolve!: (value: string) => void;
    const h = setup(vi.fn(() => new Promise<string>((done) => { resolve = done; })));
    const old = input('late'); await vi.advanceTimersByTimeAsync(55000);
    h.bot.observe(old, false); await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(2000); resolve('{"reply":"too late"}');
    await vi.advanceTimersByTimeAsync(1); expect(h.send).not.toHaveBeenCalled(); h.bot.stop();
  });
  it('persists group opt-out and cancels pending replies when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'intervention-'));
    const deps = { chats: ['group'], settingsPath: join(root, 'settings.json'), cooldownMs: 180000,
      generate: vi.fn().mockResolvedValue('{"reply":"answer"}'), send: vi.fn(), authorized: () => true, busy: () => false };
    try {
      const bot = new SmartIntervention(deps); bot.observe(input('q'), false); await bot.setEnabled('group', false);
      await vi.advanceTimersByTimeAsync(5000); expect(deps.send).not.toHaveBeenCalled(); bot.stop();
      const restarted = new SmartIntervention(deps); await restarted.load(); expect(restarted.enabled('group')).toBe(false); restarted.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
