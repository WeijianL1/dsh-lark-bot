import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { downloadInRanges, DownloadLimitError, type RangeRequest } from '../../src/media/range-download.js';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
describe('download disk reservation', () => {
  it('reserves space across concurrent files and releases it after cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'download-disk-'));
    const original = await statfs(root);
    vi.mocked(statfs).mockResolvedValue({ ...original, bavail: 180 * 1024 ** 2, bsize: 1 } as never);
    let chunks = 0;
    const request: RangeRequest = async (range, signal) => {
      if (range === 'bytes=0-0') return new Response('a', { status: 206, headers: { 'Content-Range': `bytes 0-0/${80 * 1024 ** 2}` } });
      chunks++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const firstStop = new AbortController(), thirdStop = new AbortController();
    try {
      const first = downloadInRanges(request, 'a', join(root, 'a'), { signal: firstStop.signal });
      const firstSettled = first.catch(() => undefined);
      await vi.waitFor(() => expect(chunks).toBe(1));
      await expect(downloadInRanges(request, 'b', join(root, 'b'))).rejects.toBeInstanceOf(DownloadLimitError);
      firstStop.abort(); await firstSettled;
      const third = downloadInRanges(request, 'c', join(root, 'c'), { signal: thirdStop.signal });
      const thirdSettled = third.catch(() => undefined);
      await vi.waitFor(() => expect(chunks).toBe(2));
      thirdStop.abort(); await thirdSettled;
    } finally {
      firstStop.abort(); thirdStop.abort();
      vi.mocked(statfs).mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
