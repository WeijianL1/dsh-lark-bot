import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { prepareAttachments } from '../../src/media/attachments.js';

function message(resources: NormalizedMessage['resources']): NormalizedMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'user-1',
    content: 'please review this',
    rawContentType: 'text',
    resources,
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
  };
}

function fakeChannel(files: Record<string, string | Buffer>): LarkChannel {
  return {
    downloadResourceToFile: vi.fn().mockImplementation(
      async (_messageId: string, fileKey: string, _type: string, destPath: string) => {
        await writeFile(destPath, files[fileKey] ?? '');
        return { filePath: destPath };
      },
    ),
  } as unknown as LarkChannel;
}

describe('prepareAttachments', () => {
  it('downloads images and embeds text file content into prompt notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'));
    try {
      const result = await prepareAttachments(
        fakeChannel({
          'img-key': Buffer.from('89504e470d0a1a0a00000000', 'hex'),
          'txt-key': 'hello from file',
        }),
        message([
          { type: 'image', fileKey: 'img-key', fileName: 'diagram.png' },
          { type: 'file', fileKey: 'txt-key', fileName: 'notes.txt' },
        ]),
        join(root, 'media'),
      );

      expect(result.imagePaths).toHaveLength(1);
      expect(result.imagePaths[0]).toMatch(/\.png$/);
      expect(result.textFileNotes[0]).toContain('notes.txt');
      expect(result.textFileNotes[0]).toContain('hello from file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('removes partial downloads and returns a safe actionable size-limit error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'));
    const channel = {
      downloadResourceToFile: async (_id: string, _key: string, _type: string, dest: string) => {
        await writeFile(dest, 'partial');
        throw { response: { data: { code: 234037 } }, config: { headers: { authorization: 'private' } } };
      },
    } as unknown as LarkChannel;
    try {
      await expect(prepareAttachments(channel, message([{ type: 'file', fileKey: 'big' }]), root))
        .rejects.toThrow('请压缩或拆分后重新发送');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes even a small PDF as a file path rather than binary text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'));
    try {
      const result = await prepareAttachments(fakeChannel({ pdf: '%PDF-1.4 binary' }),
        message([{ type: 'file', fileKey: 'pdf', fileName: 'small.pdf' }]), root);
      expect(result.textFileNotes[0]).toContain(join(root, 'msg-1-pdf'));
      expect(result.textFileNotes[0]).not.toContain('%PDF');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('hands PDF OCR text and review pages to the agent after download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'));
    try {
      const ocr = vi.fn(async (path: string) => {
        expect(await readFile(path, 'utf8')).toBe('%PDF-test');
        return { textPath: path+'.ocr/document.md', reportPath: path+'.ocr/report.json', reviewPages: [2, 3], totalPages: 5 };
      });
      const result = await prepareAttachments(fakeChannel({ pdf: '%PDF-test' }),
        message([{ type: 'file', fileKey: 'pdf', fileName: 'scan.pdf' }]), root, { ocr });
      expect(ocr).toHaveBeenCalledOnce();
      expect(result.textFileNotes.join('\n')).toContain('document.md');
      expect(result.textFileNotes.join('\n')).toContain('report.json');
      expect(result.textFileNotes.join('\n')).not.toContain('%PDF-test');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a completed range cache when a later metadata probe fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lark-media-'));
    const path = join(root, 'msg-1-pdf');
    try {
      await writeFile(path, 'verified-cache');
      await expect(prepareAttachments(fakeChannel({}), message([{ type: 'file', fileKey: 'pdf' }]), root,
        { download: async () => { throw new Error('probe offline'); } })).rejects.toThrow('附件下载失败');
      expect(await readFile(path, 'utf8')).toBe('verified-cache');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
