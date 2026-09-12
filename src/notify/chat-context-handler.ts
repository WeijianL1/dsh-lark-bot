import type { NormalizedMessage } from '@larksuite/channel';
import type { ChatContextReader } from '../bridge/chat-context.js';
export interface ChatContextPayload { token: string; sessionId: string; action: 'history' | 'download'; before?: number; cursor?: string; messageId?: string; fileKey?: string }
export interface ChatContextResult { ok: boolean; data?: unknown; error?: string }
export function buildChatContextHandler(deps: {
  reader: ChatContextReader;
  binding(sessionId: string): { chatId: string; threadId?: string; workspace: string } | undefined;
  download(message: NormalizedMessage, workspace: string, signal: AbortSignal): Promise<unknown>;
}) {
  return async (payload: ChatContextPayload, signal: AbortSignal): Promise<ChatContextResult> => {
    const binding = deps.binding(payload.sessionId);
    if (!binding) return { ok: false, error: 'No authorized current-chat binding' };
    try {
      if (payload.action === 'history') {
        if (payload.before !== undefined && (!Number.isFinite(payload.before) || payload.before <= 0)) throw new Error('before must be a positive timestamp in milliseconds');
        const data = await deps.reader.snapshot(binding.chatId, binding.threadId, payload.before, payload.cursor);
        return { ok: data.status === 'available', data };
      }
      if (payload.action !== 'download' || !payload.messageId || !payload.fileKey) throw new Error('messageId and fileKey required');
      const message = await deps.reader.message(binding.chatId, payload.messageId, binding.threadId);
      const resource = message.resources.find((r) => r.fileKey === payload.fileKey && (r.type === 'file' || r.type === 'image'));
      if (!resource) throw new Error('Attachment does not belong to this message');
      signal.throwIfAborted();
      return { ok: true, data: await deps.download({ ...message, resources: [resource] }, binding.workspace, signal) };
    } catch { return { ok: false, error: 'Could not read current-chat history or attachment; verify the message and attachment identifiers, availability and download limits.' }; }
  };
}
