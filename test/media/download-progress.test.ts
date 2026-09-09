import { describe, expect, it, vi } from 'vitest';
import { downloadProgress } from '../../src/media/download-progress.js';
import type { StreamingChannel } from '../../src/bridge/types.js';
describe('download progress', () => {
  it('creates one card in the source thread and updates its terminal state', async () => {
    const sendCard = vi.fn().mockResolvedValue('card');
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const progress = downloadProgress({ sendCard, updateCard } as unknown as StreamingChannel, { chatId: 'chat', messageId: 'source', threadId: 'thread' });
    progress.update(0, 100 * 1024 ** 2);
    progress.update(1, 100 * 1024 ** 2);
    await progress.finish(true);
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendCard.mock.calls[0]?.[2]).toEqual({ replyTo: 'source', threadId: 'thread' });
    await vi.waitFor(() => expect(JSON.stringify(updateCard.mock.calls)).toContain('附件已下载'));
  });
  it('does not fail downloads when the card API rejects', async () => {
    const progress = downloadProgress({ sendCard: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as StreamingChannel, { chatId: 'chat', messageId: 'source' });
    progress.update(0, 100 * 1024 ** 2);
    await expect(progress.finish(false)).resolves.toBeUndefined();
  });
  it('does not await a hung card API when completing or cancelling a download', async () => {
    const progress = downloadProgress({ sendCard: vi.fn(() => new Promise(() => {})) } as unknown as StreamingChannel, { chatId: 'chat', messageId: 'source' });
    progress.update(0, 100 * 1024 ** 2);
    await expect(progress.finish(false)).resolves.toBeUndefined();
  });

});
