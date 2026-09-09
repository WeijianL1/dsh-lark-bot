import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ActiveRuns } from '../../src/bot/active-runs.js';
import { buildOcrHandler } from '../../src/media/ocr-handler.js';
import type { StreamingChannel } from '../../src/bridge/types.js';

describe('legacy OCR bridge', () => {
  it('binds progress to the originating session and makes OCR stoppable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-ocr-'));
    const source = join(root, 'input.pdf'); await writeFile(source, 'fixture');
    const runs = new ActiveRuns(); const controllers = new Set<AbortController>();
    const sendCard = vi.fn().mockResolvedValue('card');
    let processing = false;
    const handler = buildOcrHandler({
      binding: async () => ({ scope: 'scope', workspace: root, roots: [root], chatId: 'chat', messageId: 'message', threadId: 'thread' }),
      channel: () => ({ sendCard } as unknown as StreamingChannel), activeRuns: runs, controllers, python: 'python3',
      run: async (path, options) => {
        expect(path).toBe(source); expect(options.pages).toEqual([1, 2]);
        options.onEvent?.({ type: 'started', total: 2, done: 0 }); processing = true;
        await new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('stop')), { once: true }));
        throw new Error('unreachable');
      },
    });
    try {
      const task = handler({ token: 'token', sessionId: 'session', path: source, pages: [1, 2] });
      await vi.waitFor(() => expect(processing).toBe(true));
      expect(sendCard.mock.calls[0]?.[2]).toEqual({ replyTo: 'message', threadId: 'thread' });
      await runs.interrupt('scope');
      expect(await task).toMatchObject({ ok: false, error: expect.stringContaining('stopped') });
      expect(controllers.size).toBe(0); expect(runs.count('scope')).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects symlink escapes without starting OCR or sending a card', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-ocr-'));
    const outside = await mkdtemp(join(tmpdir(), 'other-workspace-'));
    await writeFile(join(outside, 'secret.pdf'), 'private'); await symlink(join(outside, 'secret.pdf'), join(root, 'link.pdf'));
    const run = vi.fn(); const sendCard = vi.fn();
    const handler = buildOcrHandler({ binding: async () => ({ scope: 'scope', workspace: root, roots: [root], chatId: 'chat', messageId: 'message' }),
      channel: () => ({ sendCard } as unknown as StreamingChannel), activeRuns: new ActiveRuns(), controllers: new Set(), python: 'python3', run });
    try {
      expect(await handler({ token: '', sessionId: 'session', path: join(root, 'link.pdf') })).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled(); expect(sendCard).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
