import { describe, expect, it, vi } from 'vitest';
import { ChatContextReader, entryFor, renderChatContext } from '../../src/bridge/chat-context.js';
import type { NormalizedMessage } from '@larksuite/channel';
const message = (overrides = {}): NormalizedMessage => ({ messageId: 'current', chatId: 'group', chatType: 'group', senderId: 'a', senderType: 'user', content: '读刚才的文件', createTime: 2000, resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: 'text', ...overrides });
const item = (id: string, sender: string, content: unknown, more = {}) => ({ message_id: id, chat_id: 'group', create_time: '1000', sender: { id: sender, sender_type: 'user' }, body: { content: JSON.stringify(content) }, ...more });
function fixture(items: unknown[]) {
  const list = vi.fn().mockResolvedValue({ code: 0, data: { items, has_more: true } });
  const get = vi.fn().mockResolvedValue({ code: 0, data: { items: [] } });
  const downloadResourceToFile = vi.fn();
  const channel = { rawClient: { im: { message: { list, get } } }, getChatMembers: vi.fn().mockResolvedValue([{ id: 'a', name: '同名' }, { id: 'b', name: '同名' }]), downloadResourceToFile };
  return { reader: new ChatContextReader(() => channel as never), ...channel, list, get };
}
describe('Feishu conversation grounding', () => {
  it('processes a full page of sparse cards within the metadata budget', async () => {
    const f = fixture(Array.from({ length: 50 }, (_, i) => item(String(i), 'bot', { body: { elements: [{ tag: 'div' }] } }, { msg_type: 'interactive' })));
    const start = performance.now();
    expect((await f.reader.snapshot('group')).messages).toHaveLength(50);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('preserves every author when requests from different people are batched', async () => {
    const f = fixture([item('a-msg', 'a', { text: 'A' }), item('b-msg', 'b', { text: 'B' })]);
    const batch = [message({ messageId: 'a-msg', senderId: 'a' }), message({ messageId: 'b-msg', senderId: 'b' })];
    const text = await f.reader.forTurn(batch[1]!, batch);
    const data = JSON.parse(text.split('\n')[3]!);
    expect(data.current.sender.id).toBe('b');
    expect(data.currentBatch.map((m: {sender: {id: string}}) => m.sender.id)).toEqual(['a', 'b']);
    expect(data.history.messages).toEqual([]);
  });

  it('reads authoritative raw chat/thread metadata and nested post attachments', async () => {
    const f = fixture([item('post', 'a', { zh_cn: { content: [[{ tag: 'img', image_key: 'image-key' }]] } })]);
    expect((await f.reader.snapshot('group')).messages[0]?.attachments[0]?.key).toBe('image-key');
    f.get.mockResolvedValue({ code: 0, data: { items: [item('file', 'b', { file_key: 'key', file_name: 'case.pdf' }, { msg_type: 'file', thread_id: 't' })] } } as never);
    const read = await f.reader.message('group', 'file', 't');
    expect(read.chatId).toBe('group');
    expect(read.threadId).toBe('t');
    expect(read.senderId).toBe('b');
    expect(read.resources).toEqual([{ type: 'file', fileKey: 'key', fileName: 'case.pdf' }]);
    await expect(f.reader.message('group', 'file', 'another-thread')).rejects.toThrow('outside');
  });

  it('paginates with scoped cursors without skipping equal-time messages', async () => {
    const f = fixture([]);
    f.list.mockResolvedValueOnce({ code: 0, data: { items: [item('new', 'a', { text: 'new' })], has_more: true, page_token: 'opaque' } });
    const first = await f.reader.snapshot('group');
    expect(first.nextCursor).toBeTruthy();
    f.list.mockResolvedValueOnce({ code: 0, data: { items: [item('older', 'b', { text: 'same timestamp' })], has_more: false } });
    const second = await f.reader.snapshot('group', undefined, 1, first.nextCursor);
    expect(second.messages[0]?.messageId).toBe('older');
    expect(f.list.mock.calls[1]?.[0].params.page_token).toBe('opaque');
    expect(f.list.mock.calls[1]?.[0].params.end_time).toBeUndefined();
    expect((await f.reader.snapshot('another-chat', undefined, undefined, first.nextCursor)).status).toBe('unavailable');
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('keeps same-name people distinct, includes bot replies and only indexes attachments', async () => {
    const f = fixture([item('1', 'a', { text: '我的材料' }), item('2', 'b', { file_name: '起诉状.pdf', file_key: 'f2' }, { msg_type: 'file' }), item('3', 'bot', { text: '已回复' }, { sender: { id: 'bot', sender_type: 'bot' } })]);
    const snapshot = await f.reader.snapshot('group');
    expect(snapshot.status).toBe('available');
    expect(snapshot.messages.slice(0, 2).map((m) => m.sender)).toEqual([{ id: 'a', kind: 'user', name: '同名' }, { id: 'b', kind: 'user', name: '同名' }]);
    expect(snapshot.messages[1]?.attachments).toEqual([{ name: '起诉状.pdf', key: 'f2', type: 'file' }]);
    expect(snapshot.messages[2]?.sender.kind).toBe('bot');
    expect(f.downloadResourceToFile).not.toHaveBeenCalled();
  });
  it('preserves sender, mentions and the actual reply target without duplicating current message', async () => {
    const f = fixture([item('current', 'a', { text: '读文件' }), item('older', 'b', { text: 'B的文件' })]);
    const text = await f.reader.forTurn(message({ replyToMessageId: 'older', mentions: [{ key: '@b', openId: 'b', name: '同名' }] }));
    const data = JSON.parse(text.split('\n')[3]!);
    expect(data.current.sender).toEqual({ id: 'a', kind: 'user', name: '同名' });
    expect(data.current.mentions[0].id).toBe('b');
    expect(data.reply.sender.id).toBe('b');
    expect(data.history.messages.map((m: {messageId: string}) => m.messageId)).toEqual(['older']);
  });
  it('uses an explicit unavailable state, keeps unknown names unknown, and tolerates denied roster access', async () => {
    const f = fixture([item('1', 'a', { text: '你好' })]);
    f.getChatMembers.mockRejectedValue(new Error('denied'));
    expect((await f.reader.snapshot('group')).messages[0]?.sender.name).toBeUndefined();
    f.list.mockRejectedValue(new Error('denied'));
    expect((await f.reader.snapshot('group')).status).toBe('unavailable');
    expect(renderChatContext(entryFor(message()))).toContain('Never apply the default USER.md name');
  });
  it('bounds text, skips recalled and foreign messages, restricts thread and rejects cross-chat reply targets', async () => {
    const f = fixture([item('1', 'a', { text: 'x'.repeat(10000) }), item('2', 'a', { text: 'gone' }, { deleted: true }), item('3', 'a', { text: 'private' }, { chat_id: 'private' })]);
    const snapshot = await f.reader.snapshot('group', 'thread', 3000);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text.length).toBe(1200);
    expect(f.list).toHaveBeenCalledWith({ params: expect.objectContaining({ container_id_type: 'thread', container_id: 'thread', end_time: '3' }) });
    f.get.mockResolvedValue({ code: 0, data: { items: [item('foreign', 'a', { text: 'private' }, { chat_id: 'private' })] } } as never);
    await expect(f.reader.message('group', 'foreign')).rejects.toThrow('outside');
  });
});
