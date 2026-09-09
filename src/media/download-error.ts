import { Readable } from 'node:stream';

const MAX_ERROR_BYTES = 8192;
const ERROR_BODY_TIMEOUT_MS = 1000;

/** Safe to persist and show to users; never retains HTTP headers or config. */
export class AttachmentDownloadError extends Error {
  constructor(readonly messageId: string, readonly sizeExceeded: boolean, message?: string) {
    super(message ?? (sizeExceeded
      ? '附件超过飞书下载限制，请压缩或拆分后重新发送。 / Attachment exceeds the Feishu download limit. Please compress or split it and resend.'
      : '附件下载失败，请重新发送附件后再试。 / Attachment download failed. Please resend the attachment and try again.'));
    this.name = 'AttachmentDownloadError';
  }
}

/** SDK errors may carry JSON, bytes, or a streaming HTTP response body. */
export async function attachmentDownloadError(error: unknown, messageId: string): Promise<AttachmentDownloadError> {
  let body = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (body instanceof Readable) {
    const stream = body;
    const timer = setTimeout(() => stream.destroy(new Error('error body timeout')), ERROR_BODY_TIMEOUT_MS);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_ERROR_BYTES) break;
        chunks.push(bytes);
      }
      body = size <= MAX_ERROR_BYTES ? Buffer.concat(chunks) : undefined;
    } catch {
      body = undefined;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }
  if (Buffer.isBuffer(body)) body = body.length <= MAX_ERROR_BYTES ? body.toString('utf8') : undefined;
  if (typeof body === 'string') {
    try {
      body = Buffer.byteLength(body) <= MAX_ERROR_BYTES ? JSON.parse(body) : undefined;
    } catch {
      body = undefined;
    }
  }
  const code = (body as { code?: unknown } | null)?.code;
  return new AttachmentDownloadError(messageId, code === 234037 || code === '234037');
}
