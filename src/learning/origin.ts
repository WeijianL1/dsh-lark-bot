import type { DurableQueuedMessage } from '../bot/job-ledger.js';
import type { LearningIdentity } from './journal.js';
export interface LearningOrigin { sessionId: string; messageId: string; workspace: string }
/** Transport records, never model text or a most-recent-user guess, identify a Feishu speaker. */
export function resolveLearningIdentity(input: {
  sessionId: string; workspace: string; rpcId?: string | undefined;
  origin?: LearningOrigin | undefined; boundToFeishu: boolean;
  message?: DurableQueuedMessage | undefined;
}): (LearningIdentity & { originalText?: string }) | undefined {
  const { origin, message, workspace, sessionId } = input;
  if (origin) {
    if (!message || origin.sessionId !== sessionId || origin.workspace !== workspace || message.workspaceCwd !== workspace ||
        !message.senderId || message.senderType === 'app' || message.senderType === 'bot') return;
    return { transport: 'feishu', chatId: message.chatId, chatType: message.chatType, actorId: message.senderId, workspace,
      originalText: message.content.split('\n\n<scoped_feedback_memory>')[0]! };
  }
  if (!input.rpcId || input.boundToFeishu) return;
  return { transport: 'local', chatId: 'local-web', chatType: 'p2p', actorId: 'local-owner', workspace };
}
