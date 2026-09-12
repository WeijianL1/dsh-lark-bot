import { describe, expect, it, vi } from 'vitest';
import { buildChatContextHandler } from '../../src/notify/chat-context-handler.js';

describe('current-chat history and attachment access', () => {
  it('requires session binding and exact attachment membership before downloading', async () => {
    const snapshot = vi.fn().mockResolvedValue({ status: 'available', messages: [] });
    const message = vi.fn().mockResolvedValue({ messageId: 'm', chatId: 'group', resources: [{ type: 'file', fileKey: 'actual', fileName: 'case.pdf' }] });
    const download = vi.fn().mockResolvedValue({ textFileNotes: ['local case.pdf'] });
    const handler = buildChatContextHandler({ reader: { snapshot, message } as never,
      binding: (id) => id === 'session' ? { chatId: 'group', workspace: '/work' } : undefined, download });
    const signal = new AbortController().signal;
    expect((await handler({ token: '', sessionId: 'unknown', action: 'history' }, signal)).ok).toBe(false);
    expect(snapshot).not.toHaveBeenCalled();
    expect((await handler({ token: '', sessionId: 'session', action: 'download', messageId: 'm', fileKey: 'wrong' }, signal)).ok).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect((await handler({ token: '', sessionId: 'session', action: 'download', messageId: 'm', fileKey: 'actual' }, signal)).ok).toBe(true);
    expect(message).toHaveBeenCalledWith('group', 'm', undefined);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm' }), '/work', signal);
  });
  it('forwards scoped pagination and never downloads when reading history', async () => {
    const snapshot = vi.fn().mockResolvedValue({ status: 'available', messages: [] });
    const download = vi.fn();
    const handler = buildChatContextHandler({ reader: { snapshot } as never,
      binding: () => ({ chatId: 'group', threadId: 'thread', workspace: '/work' }), download });
    expect((await handler({ token: '', sessionId: 's', action: 'history', before: 1000 }, new AbortController().signal)).ok).toBe(true);
    expect(snapshot).toHaveBeenCalledWith('group', 'thread', 1000, undefined);
    expect(download).not.toHaveBeenCalled();
  });
});
