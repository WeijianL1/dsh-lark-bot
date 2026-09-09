import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import workerSource from './pdf-ocr-worker.py?raw';

export interface OcrEvent {
  type: 'queued' | 'preparing' | 'started' | 'page' | 'retry' | 'progress' | 'complete' | 'fatal' | 'stopped';
  total?: number;
  done?: number;
  page?: number;
  cached?: number;
  region?: number;
  regions?: number;
  reviewPages?: number[];
  reviewRanges?: string;
  totalPages?: number;
  processedPages?: number[];
  errorPages?: number[];
  output?: string;
}
export interface OcrResult { textPath: string; reportPath: string; reviewPages: number[]; totalPages: number }
export interface OcrOptions {
  python?: string;
  signal?: AbortSignal;
  onEvent?: (event: OcrEvent) => void;
  /** Only for explicit partial processing/testing. Omitted in the bot pipeline. */
  pages?: number[];
  pageTimeoutSeconds?: number;
}
export class PdfOcrError extends Error { messageId?: string }

let running = false;
const waiting = new Set<() => void>();
async function acquire(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (running) await new Promise<void>((resolve, reject) => {
    const ready = () => { waiting.delete(ready); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { waiting.delete(ready); reject(signal?.reason); };
    waiting.add(ready);
    signal?.addEventListener('abort', abort, { once: true });
  });
  running = true;
  return () => {
    const next = waiting.values().next().value;
    if (next) next();
    else running = false;
  };
}

/** One CPU worker across chats; child process owns bounded per-page workers. */
export async function runPdfOcr(source: string, options: OcrOptions = {}): Promise<OcrResult> {
  options.onEvent?.({ type: 'queued' });
  const release = await acquire(options.signal);
  try {
    options.signal?.throwIfAborted();
    const runtime = join(dirname(source), '.pdf-ocr-runtime');
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(workerSource).digest('hex');
    const script = join(runtime, `${digest}.py`);
    if (await readFile(script, 'utf8').catch(() => '') !== workerSource) {
      const temp = `${script}.tmp`;
      await writeFile(temp, workerSource, { mode: 0o600 });
      await rename(temp, script);
    }
    const selection = options.pages ? createHash('sha256').update(JSON.stringify([...new Set(options.pages)].sort((a, b) => a-b))).digest('hex').slice(0, 16) : '';
    const output = `${source}.ocr${selection ? `-${selection}` : ''}`;
    const args = [script, '--source', source, '--output', output,
      '--page-timeout', String(options.pageTimeoutSeconds ?? 120)];
    if (options.pages) args.push('--pages', options.pages.join(','));
    const result = await new Promise<OcrResult>((resolve, reject) => {
      const child = spawn(options.python ?? 'python3', args, {
        cwd: dirname(source), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' },
      });
      let buffer = '';
      let complete: OcrEvent | undefined;
      let reason = 'OCR 处理未完成，请重试原附件任务以继续。 / OCR did not finish; retry the original attachment job to resume.';
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
          else if (child.pid && process.platform === 'win32') {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.on('error', () => child.kill(signal));
          } else child.kill(signal);
        } catch { /* process already exited */ }
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 3000);
        killTimer.unref();
      };
      const abort = () => stop();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) stop();
      // Guard crashes/stalls outside a per-page deadline (manifest/hash/report).
      let watchdog = setTimeout(() => { reason = 'OCR 长时间无进展，已暂停；重试原附件可继续。'; stop(); }, 180_000);
      watchdog.unref();
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort);
        clearTimeout(killTimer);
        clearTimeout(watchdog);
      };
      child.stdout.on('data', (bytes: Buffer) => {
        buffer += bytes.toString('utf8');
        if (buffer.length > 512_000) { reason = 'OCR progress exceeded the safety limit'; stop(); return; }
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const event = JSON.parse(line) as OcrEvent & { reason?: string };
            clearTimeout(watchdog);
            watchdog = setTimeout(() => { reason = 'OCR 长时间无进展，已暂停；重试原附件可继续。'; stop(); }, 180_000);
            watchdog.unref();
            if (event.type === 'complete') complete = event;
            if (event.type === 'fatal' && /ModuleNotFoundError|PackageNotFoundError/.test(event.reason ?? '')) {
              reason = 'OCR 依赖尚未安装，请按插件文档配置 Python OCR 环境。 / OCR Python dependencies are missing.';
            }
            if (!stopped) options.onEvent?.(event);
          } catch { /* ignore non-protocol output from a dependency */ }
        }
      });
      // Dependency diagnostics may contain document text; never forward them to logs/cards.
      child.stderr.resume();
      child.once('error', () => { cleanup(); reject(new PdfOcrError('无法启动 OCR Python 环境。 / Cannot start the OCR Python worker.')); });
      child.once('close', (code) => {
        cleanup();
        if (options.signal?.aborted) { reject(options.signal.reason); return; }
        if (code !== 0 || stopped || !complete || !Array.isArray(complete.reviewPages) || typeof complete.totalPages !== 'number') {
          reject(new PdfOcrError(reason)); return;
        }
        resolve({ textPath: join(output, 'document.md'), reportPath: join(output, 'report.json'),
          reviewPages: complete.reviewPages, totalPages: complete.totalPages });
      });
    });
    return result;
  } finally { release(); }
}
