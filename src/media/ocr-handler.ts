import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPathWithin } from '../config/security.js';
import type { ActiveRuns } from '../bot/active-runs.js';
import type { StreamingChannel } from '../bridge/types.js';
import { ocrProgress } from './ocr-progress.js';
import { runPdfOcr, type OcrOptions, type OcrResult } from './pdf-ocr.js';

export interface OcrPayload { token: string; sessionId: string; path: string; pages?: number[] }
export interface OcrHandlerDeps {
  binding(sessionId: string): Promise<{ scope: string; workspace: string; roots: string[];
    chatId: string; messageId: string; threadId?: string } | undefined>;
  channel(): StreamingChannel | undefined;
  activeRuns: ActiveRuns;
  controllers: Set<AbortController>;
  python: string;
  run?: (path: string, options: OcrOptions) => Promise<OcrResult>;
}

/** Resolve the destination from the session, never from caller-supplied chat IDs. */
export function buildOcrHandler(deps: OcrHandlerDeps) {
  return async (payload: OcrPayload, signal?: AbortSignal) => {
    const binding = await deps.binding(payload.sessionId);
    const channel = deps.channel();
    if (!binding || !channel) return { ok: false, error: 'No active Lark binding for this session' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const runId = `ocr-${randomUUID()}`;
    let update: ReturnType<typeof ocrProgress> | undefined;
    try {
      const source = await realpath(resolve(binding.workspace, payload.path));
      const roots = await Promise.all(binding.roots.map((root) => realpath(root)));
      if (!roots.some((root) => isPathWithin(root, source))) return { ok: false, error: 'PDF is outside this session workspace' };
      controller.signal.throwIfAborted();
      update = ocrProgress(channel, binding, basename(source));
      deps.controllers.add(controller);
      deps.activeRuns.set(binding.scope, { runId, workspaceCwd: binding.workspace, stop: async () => controller.abort() });
      const result = await (deps.run ?? runPdfOcr)(source, { python: deps.python,
        signal: controller.signal, onEvent: update, ...(payload.pages ? { pages: payload.pages } : {}) });
      return { ok: true, ...result };
    } catch {
      update?.({ type: controller.signal.aborted ? 'stopped' : 'fatal' });
      return { ok: false, error: controller.signal.aborted ? 'OCR stopped; rerun the same command to resume' : 'OCR failed; check the PDF and Python environment, then rerun to resume' };
    } finally {
      signal?.removeEventListener('abort', abort);
      deps.controllers.delete(controller);
      deps.activeRuns.delete(binding.scope, runId);
    }
  };
}
