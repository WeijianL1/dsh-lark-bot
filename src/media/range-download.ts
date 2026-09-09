import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class DownloadLimitError extends Error {}
export class DownloadProtocolError extends Error {}
export class DownloadHttpError extends Error {
  constructor(readonly status: number, readonly apiCode?: number) {
    super(`Attachment HTTP ${status}${apiCode ? ` (code ${apiCode})` : ''}`);
  }
}
export type RangeRequest = (range: string, signal: AbortSignal) => Promise<Response>;
export interface DownloadOptions {
  maxBytes?: number;
  chunkBytes?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}
interface Receipt { version: 1; identity: string; total: number; chunkBytes: number; hashes: string[] }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new DownloadProtocolError('Missing attachment body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new DownloadProtocolError('Attachment response exceeds requested size');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Shared by metadata probes and chunks; deadlines cover headers AND body. */
async function requestChunk(request: RangeRequest, start: number, end: number, options: DownloadOptions,
  expectedTotal?: number): Promise<{ bytes: Buffer; total: number; whole: boolean }> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 60_000), ...(options.signal ? [options.signal] : [])]);
    try {
      const response = await request(`bytes=${start}-${end}`, signal);
      try {
        if (!response.ok) {
          let code: number | undefined;
          try { code = JSON.parse((await readBounded(response, 8192)).toString()).code; } catch { /* safe generic error */ }
          throw new DownloadHttpError(response.status, code);
        }
        if (response.status === 200 && expectedTotal === undefined) {
          // Range ignored: only accept a bounded, explicitly sized small file.
          const length = Number(response.headers.get('content-length'));
          if (!response.headers.has('content-length') || !Number.isSafeInteger(length) || length < 0) {
            throw new DownloadProtocolError('Server ignored Range without a usable file size');
          }
          if (length > (options.maxBytes ?? 1024 ** 3)) throw new DownloadLimitError('Attachment exceeds configured download limit');
          if (length > (options.chunkBytes ?? 8 * 1024 ** 2)) throw new DownloadProtocolError('Large attachment server ignored Range');
          const bytes = await readBounded(response, length);
          if (bytes.length !== length) throw new Error('Truncated attachment body');
          return { bytes, total: length, whole: true };
        }
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (response.status !== 206 || !match) throw new DownloadProtocolError('Invalid attachment range response');
        const [actualStart, actualEnd, total] = match.slice(1).map(Number) as [number, number, number];
        if (![actualStart, actualEnd, total].every(Number.isSafeInteger) || total <= 0 || actualStart !== start ||
          actualEnd !== Math.min(end, total - 1) || actualEnd < actualStart ||
          (expectedTotal !== undefined && total !== expectedTotal)) throw new DownloadProtocolError('Attachment range mismatch');
        if (total > (options.maxBytes ?? 1024 ** 3)) throw new DownloadLimitError('Attachment exceeds configured download limit');
        const bytes = await readBounded(response, actualEnd - actualStart + 1);
        if (bytes.length !== actualEnd - actualStart + 1) throw new Error('Truncated attachment chunk');
        return { bytes, total, whole: false };
      } finally { await response.body?.cancel().catch(() => undefined); }
    } catch (error) {
      const permanent = error instanceof DownloadLimitError || error instanceof DownloadProtocolError ||
        error instanceof DownloadHttpError && error.status !== 429 && error.status < 500;
      if (options.signal?.aborted || permanent || attempt >= (options.retries ?? 2)) throw error;
      await delay((options.retryDelayMs ?? 500) * 2 ** attempt, undefined, { signal: options.signal });
    }
  }
}

// Bound aggregate memory and disk traffic across chats, not just per file.
let activeDownloads = 0;
let reservedBytes = 0;
const waiters = new Set<() => void>();
async function acquire(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (activeDownloads >= 2) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        waiters.delete(ready);
        signal?.removeEventListener('abort', cancel);
        activeDownloads++;
        resolve();
      };
      const cancel = () => {
        waiters.delete(ready);
        reject(signal?.reason);
      };
      waiters.add(ready);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  } else activeDownloads++;
  return () => {
    activeDownloads--;
    waiters.values().next().value?.();
  };
}

/** One owner per destination; concurrent messages reuse its promise. */
const downloads = new Map<string, Promise<void>>();
export function downloadInRanges(request: RangeRequest, identity: string, destination: string, options: DownloadOptions = {}): Promise<void> {
  const active = downloads.get(destination);
  if (active) return active;
  const pending = (async () => {
    const release = await acquire(options.signal);
    try { await download(request, identity, destination, options); } finally { release(); }
  })().finally(() => downloads.delete(destination));
  downloads.set(destination, pending);
  return pending;
}

async function download(request: RangeRequest, identity: string, destination: string, options: DownloadOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? 1024 ** 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid attachment size limit');
  const chunkBytes = options.chunkBytes ?? 8 * 1024 ** 2;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 32 * 1024 ** 2) throw new Error('Invalid download chunk size');
  options = { ...options, signal: AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(options.signal ? [options.signal] : [])]) };
  const probe = await requestChunk(request, 0, 0, options);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const receiptPath = `${destination}.download.json`;
  const receipt: Receipt = { version: 1, identity, total: probe.total, chunkBytes, hashes: [] };
  if (probe.whole) {
    const file = await open(partial, 'w', 0o600);
    try { await file.writeFile(probe.bytes); await file.sync(); } finally { await file.close(); }
    await rename(partial, destination);
    await rm(receiptPath, { force: true });
    options.onProgress?.(probe.total, probe.total);
    return;
  }
  let saved: Receipt | undefined;
  try {
    if ((await stat(receiptPath)).size <= 1024 * 1024) saved = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
  } catch { /* no reusable receipt */ }
  const valid = saved?.version === 1 && saved.identity === identity && saved.total === probe.total &&
    saved.chunkBytes === chunkBytes && Array.isArray(saved.hashes) && saved.hashes.length <= Math.ceil(probe.total / chunkBytes) &&
    saved.hashes.every((h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
  let existing = partial;
  try { await stat(partial); } catch { existing = destination; }
  // Verify every saved chunk before reuse, including a completed cached file.
  if (valid) {
    try {
      const file = await open(existing, 'r');
      try {
        for (let i = 0; i < saved!.hashes.length; i++) {
          options.signal?.throwIfAborted();
          const size = Math.min(chunkBytes, probe.total - i * chunkBytes);
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await file.read(buffer, 0, size, i * chunkBytes);
          if (bytesRead !== size || hash(buffer) !== saved!.hashes[i]) break;
          receipt.hashes.push(saved!.hashes[i]!);
        }
      } finally { await file.close(); }
    } catch { /* restart missing file */ }
  }
  options.signal?.throwIfAborted();
  let offset = Math.min(receipt.hashes.length * chunkBytes, probe.total);
  if (offset === probe.total && existing === destination && (await stat(destination)).size === probe.total) {
    options.onProgress?.(offset, probe.total);
    return;
  }
  if (existing === destination && offset > 0) await rename(destination, partial);
  const disk = await statfs(dirname(destination));
  let reserved = probe.total - offset;
  if (disk.bavail * disk.bsize - reservedBytes < reserved + 64 * 1024 ** 2) throw new DownloadLimitError('Insufficient space for attachment');
  reservedBytes += reserved;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(partial, offset ? 'r+' : 'w', 0o600);
    await file.truncate(offset);
    options.onProgress?.(offset, probe.total);
    while (offset < probe.total) {
      const end = Math.min(offset + chunkBytes, probe.total) - 1;
      const { bytes } = await requestChunk(request, offset, end, options, probe.total);
      // Explicit offsets handle short writes and resumed descriptors.
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('Attachment write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
      receipt.hashes.push(hash(bytes));
      const temp = `${receiptPath}.tmp`;
      const metadata = await open(temp, 'w', 0o600);
      try { await metadata.writeFile(JSON.stringify(receipt)); await metadata.sync(); } finally { await metadata.close(); }
      await rename(temp, receiptPath);
      reservedBytes -= bytes.length;
      reserved -= bytes.length;
      offset += bytes.length;
      options.onProgress?.(offset, probe.total);
    }
  } finally { reservedBytes -= reserved; await file?.close(); }
  await rename(partial, destination);
}
