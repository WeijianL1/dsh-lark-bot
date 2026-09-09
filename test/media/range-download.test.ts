import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadInRanges, DownloadLimitError, DownloadProtocolError, type RangeRequest } from '../../src/media/range-download.js';
const roots: string[] = [];
async function target() { const p = await mkdtemp(join(tmpdir(), 'ranges-')); roots.push(p); return join(p, 'file'); }
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const data = Buffer.from('abcdefghijklmno');
function source() {
  return vi.fn<RangeRequest>().mockImplementation(async (range) => {
    const [start, end] = range.slice(6).split('-').map(Number) as [number, number];
    const last = Math.min(end, data.length - 1);
    return new Response(data.subarray(start, last + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${last}/${data.length}` } });
  });
}
const options = { chunkBytes: 4, retryDelayMs: 0 };
describe('range downloader', () => {
  it('probes size, downloads exact ranges, then reuses a verified cache', async () => {
    const request = source(), path = await target();
    await downloadInRanges(request, 'id', path, options);
    expect(await readFile(path)).toEqual(data);
    expect(request.mock.calls.map((c) => c[0])).toEqual(['bytes=0-0', 'bytes=0-3', 'bytes=4-7', 'bytes=8-11', 'bytes=12-14']);
    request.mockClear();
    await downloadInRanges(request, 'id', path, options);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized file from headers before consuming its body', async () => {
    const path = await target();
    const response = new Response('a', { status: 206, headers: { 'Content-Range': 'bytes 0-0/1000' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    await expect(downloadInRanges(async () => response, 'id', path, { maxBytes: 100 })).rejects.toBeInstanceOf(DownloadLimitError);
    expect(cancel).toHaveBeenCalled();
    await expect(stat(path + '.part')).rejects.toThrow();
  });
  it('resumes only committed chunks after interruption', async () => {
    const request = source(), path = await target();
    const stop = new AbortController();
    await expect(downloadInRanges(request, 'id', path, { ...options, signal: stop.signal,
      onProgress: (done) => { if (done === 4) stop.abort(); },
    })).rejects.toThrow();
    request.mockClear();
    await downloadInRanges(request, 'id', path, options);
    expect(request.mock.calls.map((c) => c[0])).toEqual(['bytes=0-0', 'bytes=4-7', 'bytes=8-11', 'bytes=12-14']);
    expect(await readFile(path)).toEqual(data);
  });
  it('re-downloads corrupt cached chunks instead of trusting the receipt', async () => {
    const request = source(), path = await target();
    await downloadInRanges(request, 'id', path, options);
    await writeFile(path, 'abcdBAD!ijklmno');
    request.mockClear();
    await downloadInRanges(request, 'id', path, options);
    expect(request.mock.calls[1]?.[0]).toBe('bytes=4-7');
    expect(await readFile(path)).toEqual(data);
  });
  it('retries a transient chunk failure without repeating earlier chunks', async () => {
    const good = source(), path = await target(); let failed = false;
    const request = vi.fn<RangeRequest>(async (range, signal) => {
      if (range === 'bytes=4-7' && !failed) { failed = true; return new Response('{}', { status: 503 }); }
      return good(range, signal);
    });
    await downloadInRanges(request, 'id', path, options);
    expect(request.mock.calls.filter((c) => c[0] === 'bytes=4-7')).toHaveLength(2);
    expect(await readFile(path)).toEqual(data);
  });
  it('rejects mismatched ranges and does not retry them', async () => {
    const request = source(), path = await target();
    request.mockResolvedValue(new Response('a', { status: 206, headers: { 'Content-Range': 'bytes 1-1/15' } }));
    await expect(downloadInRanges(request, 'id', path, options)).rejects.toBeInstanceOf(DownloadProtocolError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('handles ignored Range only for explicitly sized small responses', async () => {
    const path = await target();
    await downloadInRanges(async () => new Response('abc', { headers: { 'Content-Length': '3' } }), 'id', path, options);
    expect(await readFile(path, 'utf8')).toBe('abc');
    await expect(downloadInRanges(async () => new Response('abc'), 'id', path, options)).rejects.toThrow('without a usable file size');
    await expect(downloadInRanges(async () => new Response('abc', { headers: { 'Content-Length': '50' } }), 'id', path, options)).rejects.toThrow('ignored Range');
  });
  it('rejects a changed total, short bodies and oversized bodies', async () => {
    for (const kind of ['total', 'short', 'long']) {
      const request = source(), path = await target();
      const good = source();
      request.mockImplementation(async (range, signal) => range === 'bytes=0-0' ? good(range, signal) : new Response(
        kind === 'short' ? 'a' : kind === 'long' ? 'abcde' : 'abcd',
        { status: 206, headers: { 'Content-Range': `bytes 0-3/${kind === 'total' ? 16 : 15}` } },
      ));
      await expect(downloadInRanges(request, 'id', path, { ...options, retries: 0 })).rejects.toThrow();
      await expect(stat(path)).rejects.toThrow();
    }
  });
  it('does not retry permanent API errors', async () => {
    const request = vi.fn<RangeRequest>(async () => new Response('{"code":234037}', { status: 400 }));
    await expect(downloadInRanges(request, 'id', await target(), options)).rejects.toMatchObject({ status: 400, apiCode: 234037 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout', 'abort'])('bounds a real stalled HTTP response body (%s)', async (mode) => {
    const server = createServer((_req, res) => {
      res.writeHead(206, { 'Content-Range': 'bytes 0-0/15', 'Content-Length': '1' });
      res.flushHeaders();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const controller = new AbortController();
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const port = (server.address() as { port: number }).port;
      await expect(downloadInRanges((_range, signal) => fetch(`http://127.0.0.1:${port}`, { signal }), 'id', await target(),
        { ...options, retries: 0, timeoutMs: mode === 'timeout' ? 100 : 5000, signal: controller.signal })).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('shares an in-flight download for duplicate destination requests', async () => {
    const request = source(), path = await target();
    const first = downloadInRanges(request, 'id', path, options);
    const second = downloadInRanges(request, 'id', path, options);
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('recovers from a truncated partial and discards an invalid receipt', async () => {
    const request = source(), path = await target();
    const controller = new AbortController();
    await expect(downloadInRanges(request, 'id', path, { ...options, signal: controller.signal,
      onProgress: (done) => { if (done === 8) controller.abort(); },
    })).rejects.toThrow();
    await writeFile(path + '.part', 'abcda');
    request.mockClear();
    await downloadInRanges(request, 'id', path, options);
    expect(request.mock.calls[1]?.[0]).toBe('bytes=4-7');
    expect(await readFile(path)).toEqual(data);
    await writeFile(path + '.download.json', '{broken');
    request.mockClear();
    await downloadInRanges(request, 'id', path, options);
    expect(request.mock.calls[1]?.[0]).toBe('bytes=0-3');
  });

  it('caps concurrent downloads at two and can cancel a waiting third', async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const request = vi.fn<RangeRequest>((_range, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const paths = await Promise.all([target(), target(), target()]);
    const pending = paths.map((path, i) => downloadInRanges(request, 'id', path, { ...options, signal: controllers[i]!.signal }));
    const settled = Promise.allSettled(pending);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    controllers[2]!.abort();
    await expect(pending[2]).rejects.toThrow();
    controllers[0]!.abort(); controllers[1]!.abort();
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

});
