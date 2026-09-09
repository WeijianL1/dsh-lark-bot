import { describe, expect, it, vi } from 'vitest';
import { formatPageRanges, ocrProgress } from '../../src/media/ocr-progress.js';
import type { StreamingChannel } from '../../src/bridge/types.js';
describe('OCR progress card', () => {
  it('groups unclear page ranges and sends final warnings to the source thread', async () => {
    const sendCard = vi.fn().mockResolvedValue('card'); const updateCard = vi.fn();
    const notify = ocrProgress({ sendCard, updateCard } as unknown as StreamingChannel,
      { chatId: 'chat', messageId: 'source', threadId: 'thread' }, 'contract.pdf');
    notify({ type: 'started', total: 10, done: 0 });
    notify({ type: 'complete', processedPages: [1,2,3,4,5,6,7,8,9,10], reviewPages: [2,3,4,8] });
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalled());
    expect(sendCard.mock.calls[0]?.[2]).toEqual({ replyTo: 'source', threadId: 'thread' });
    expect(JSON.stringify(updateCard.mock.calls)).toContain('2–4、8');
    expect(formatPageRanges([9,2,1,2,5,6])).toBe('1–2、5–6、9');
  });
  it('coalesces updates and never waits on a hung card API', async () => {
    let release!: (value: string) => void;
    const sendCard = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const updateCard = vi.fn();
    const notify = ocrProgress({ sendCard, updateCard } as unknown as StreamingChannel,
      { chatId: 'chat', messageId: 'source' }, 'file.pdf');
    notify({ type: 'queued' });
    for (let i=0;i<100;i++) notify({ type: 'progress', done: i, total: 100 });
    notify({ type: 'stopped' });
    expect(sendCard).toHaveBeenCalledTimes(1);
    release('card');
    await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(updateCard.mock.calls)).toContain('断点继续');
    notify({ type: 'progress', done: 100, total: 100 });
    expect(updateCard).toHaveBeenCalledTimes(1);
  });
});
