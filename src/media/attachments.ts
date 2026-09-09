import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPathWithin, truncateUtf8Safe } from '../config/security.js';
import type {
  LarkChannel,
  NormalizedMessage,
} from '@larksuite/channel';
import { detectImageType } from './image-file.js';
import { downscaleImageIfNeeded } from './image-scale.js';
import { AttachmentDownloadError, attachmentDownloadError } from './download-error.js';
import { DownloadLimitError, DownloadHttpError, type DownloadOptions } from './range-download.js';

export interface PreparedAttachments {
  imagePaths: string[];
  textFileNotes: string[];
}

export interface PrepareAttachmentsOptions {
  /** Long-edge bound (px) for inbound images; oversized images are downscaled proportionally. */
  maxImageDimension?: number;
  download?: (messageId: string, fileKey: string, type: 'image' | 'file', destination: string, options: DownloadOptions) => Promise<void>;
  downloadOptions?: DownloadOptions;
  ocr?: (path: string, fileName: string) => Promise<{ textPath: string; reportPath: string; reviewPages: number[]; totalPages: number }>;
}

const MAX_TEXT_FILE_BYTES = 256_000;

function assertSafeMediaName(mediaDir: string, destination: string): void {
  if (!isPathWithin(mediaDir, destination)) {
    throw new Error(`unsafe attachment destination rejected: ${destination}`);
  }
}

export async function prepareAttachments(
  channel: LarkChannel | undefined,
  message: NormalizedMessage,
  mediaDir: string,
  options: PrepareAttachmentsOptions = {},
): Promise<PreparedAttachments> {
  const { maxImageDimension = 0 } = options;
  await mkdir(mediaDir, { recursive: true });
  const result: PreparedAttachments = { imagePaths: [], textFileNotes: [] };

  for (const resource of message.resources) {
    if (!channel || resource.type !== 'image' && resource.type !== 'file') continue;
    const destination = join(mediaDir, `${message.messageId}-${resource.fileKey}`);
    assertSafeMediaName(mediaDir, destination);
    const downloadPath = resource.type === 'image' ? `${destination}.download` : destination;
    assertSafeMediaName(mediaDir, downloadPath);
    try {
      if (options.download) {
        await options.download(message.messageId, resource.fileKey, resource.type, downloadPath, options.downloadOptions ?? {});
      } else await channel.downloadResourceToFile(
        message.messageId,
        resource.fileKey,
        resource.type,
        downloadPath,
      );
    } catch (error) {
      if (options.downloadOptions?.signal?.aborted) throw error;
      if (error instanceof DownloadLimitError) {
        throw new AttachmentDownloadError(message.messageId, true,
          error.message === 'Insufficient space for attachment'
            ? '服务器剩余空间不足，暂时无法下载附件。 / Insufficient server space to download the attachment.'
            : '附件超过机器人配置的下载上限，请拆分文件后重新发送。 / Attachment exceeds the configured download limit. Please split it and resend.');
      }
      const failure = error instanceof DownloadHttpError
        ? new AttachmentDownloadError(message.messageId, error.apiCode === 234037)
        : await attachmentDownloadError(error, message.messageId);
      // Range downloads own atomic final files and durable partials. A failed
      // revalidation probe must not delete an already verified cached file.
      if (!options.download) await rm(downloadPath, { force: true }).catch(() => undefined);
      throw failure;
    }

    if (resource.type === 'image') {
      try {
        const detected = await detectImageType(downloadPath);
        const imagePath = `${destination}${detected.extension}`;
        assertSafeMediaName(mediaDir, imagePath);
        await rename(downloadPath, imagePath);
        const finalPath = await downscaleImageIfNeeded(imagePath, maxImageDimension);
        result.imagePaths.push(finalPath);
      } catch (error) {
        await rm(downloadPath, { force: true });
        throw error;
      }
      continue;
    }

    if (options.ocr && /\.pdf$/i.test(resource.fileName ?? '')) {
      const ocr = await options.ocr(destination, resource.fileName ?? 'PDF');
      result.textFileNotes.push(`[attachment: ${resource.fileName ?? resource.fileKey}] ${destination}\n` +
        `[PDF OCR completed: ${ocr.totalPages} pages] Read the extracted text at ${ocr.textPath}; ` +
        `the page-level report is ${ocr.reportPath}. Do not rerun whole-document OCR. ` +
        (ocr.reviewPages.length ? `Pages needing review: ${ocr.reviewPages.join(', ')}. Tell the user these pages contain unclear or failed regions; do not claim they were fully read.` : 'No pages were flagged by the OCR quality heuristic; this is not a guarantee of accuracy.'));
      continue;
    }
    const info = await stat(destination);
    if (info.size > MAX_TEXT_FILE_BYTES || /\.pdf$/i.test(resource.fileName ?? '')) {
      result.textFileNotes.push(`[attachment: ${resource.fileName ?? resource.fileKey}] ${destination}`);
      continue;
    }

    const content = await readFile(destination, 'utf8');
    const safeContent = truncateUtf8Safe(content, MAX_TEXT_FILE_BYTES);
    result.textFileNotes.push(
      `[attachment: ${resource.fileName ?? resource.fileKey}]\n${safeContent}`,
    );
  }

  return result;
}
