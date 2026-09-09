import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLarkResourceDownloader } from '../../src/media/lark-download.js';

describe('Lark resource transport', () => {
  it('uses the tenant origin, refreshes an expired credential once and requests ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-download-'));
    let tokens = 0, rejected = false;
    const mock = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe('error');
      expect(String(url)).toMatch(/^https:\/\/open.larksuite.com\//);
      if (String(url).endsWith('/internal')) return Response.json({ code: 0, tenant_access_token: `test-${++tokens}`, expire: 7200 });
      const headers = init?.headers as Record<string, string>;
      expect(headers.Range).toBe('bytes=0-0');
      if (!rejected) { rejected = true; return new Response('{}', { status: 401 }); }
      expect(headers.Authorization).toBe('Bearer test-2');
      return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } });
    });
    try {
      const download = createLarkResourceDownloader({ appId: 'test-id', appSecret: 'test-secret', tenant: 'lark', fetch: mock });
      await download('message', 'file', 'file', join(dir, 'file'));
      expect(await readFile(join(dir, 'file'), 'utf8')).toBe('x');
      expect(tokens).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('cancels promptly while a shared token request is still pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-download-'));
    let resolveToken!: (response: Response) => void;
    const mock = vi.fn<typeof fetch>(() => new Promise((resolve) => { resolveToken = resolve; }));
    try {
      const controller = new AbortController();
      const download = createLarkResourceDownloader({ appId: 'test-id', appSecret: 'test-secret', tenant: 'feishu', fetch: mock });
      const pending = download('message', 'file', 'file', join(dir, 'file'), { signal: controller.signal });
      await vi.waitFor(() => expect(mock).toHaveBeenCalled());
      controller.abort();
      await expect(pending).rejects.toThrow();
      resolveToken(Response.json({ code: 0, tenant_access_token: 'test', expire: 7200 }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
