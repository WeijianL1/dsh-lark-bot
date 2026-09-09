import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runPdfOcr, PdfOcrError } from '../../src/media/pdf-ocr.js';

async function setup(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-worker-'));
  const python = join(dir, 'python');
  await writeFile(python, '#!/usr/bin/env python3\n'+body); await chmod(python, 0o700);
  return { dir, python, source: join(dir, 'document.pdf') };
}
describe('OCR subprocess lifecycle', () => {
  it('embeds the worker in a hashed runtime path and handles completion', async () => {
    const fixture = await setup(`import json,sys\nprint(json.dumps({'type':'complete','totalPages':3,'processedPages':[1,2,3],'reviewPages':[2]}))\n`);
    try {
      const onEvent = vi.fn();
      const result = await runPdfOcr(fixture.source, { python: fixture.python, onEvent });
      expect(result.reviewPages).toEqual([2]); expect(result.textPath).toBe(fixture.source+'.ocr/document.md');
      expect(onEvent.mock.calls.map((c)=>c[0].type)).toEqual(['queued','complete']);
    } finally { await rm(fixture.dir, { recursive: true, force: true }); }
  });
  it('cancels a running process and its child, then releases the global slot', async () => {
    const fixture = await setup(`import json,subprocess,sys,time,pathlib\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\npathlib.Path(__file__+'.pid').write_text(str(p.pid))\nprint(json.dumps({'type':'preparing'}),flush=True)\ntime.sleep(60)\n`);
    const controller = new AbortController();
    try {
      const pending = runPdfOcr(fixture.source, { python: fixture.python, signal: controller.signal,
        onEvent: (e) => { if(e.type === 'preparing') controller.abort(); } });
      await expect(pending).rejects.toThrow();
      const pid = Number(await readFile(fixture.python+'.pid','utf8'));
      await vi.waitFor(async () => {
        const status = await readFile(`/proc/${pid}/status`,'utf8').catch(()=>'');
        expect(status === '' || /State:\s+Z/.test(status)).toBe(true);
      });
      await expect(runPdfOcr(fixture.source, { python: '/nonexistent/ocr-python' })).rejects.toBeInstanceOf(PdfOcrError);
    } finally { await rm(fixture.dir, { recursive: true, force: true }); }
  });
});
