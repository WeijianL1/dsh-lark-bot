import type { AccessSnapshot } from '../config/access-manager.js';
import { randomUUID } from 'node:crypto';
import type { CardActionEvent, CardActionResponse, LarkChannel, SendInput, SendOptions, SendResult } from '@larksuite/channel';
import { log } from '../core/logger.js';
import { digest } from './tasks.js';
import { feedbackCard } from './cards.js';
import { FeedbackStore, type FeedbackRecord, type FeedbackVote } from './store.js';

const toast = (content: string, type: 'success' | 'error' = 'success'): CardActionResponse => ({ toast: { type, content } });

export function feedbackAllowed(access: AccessSnapshot, defaultDeny: boolean, actor: string, chat: string, chatType: 'p2p' | 'group'): boolean {
  if (!actor) return false;
  if (access.allowedUsers.length > 0 && !access.allowedUsers.includes(actor)) return false;
  if (chatType !== 'p2p' && access.allowedChats.length > 0 && !access.allowedChats.includes(chat)) return false;
  return access.allowedUsers.length > 0 || (chatType !== 'p2p' && access.allowedChats.length > 0) || !defaultDeny;
}

export class FeedbackService {
  constructor(
    private readonly channel: LarkChannel,
    private readonly store: FeedbackStore,
    private readonly authorized: (actor: string, chat: string, chatType: 'p2p' | 'group') => boolean,
    private readonly options: { repair?: boolean; origin?: (chatId: string, replyTo?: string) => FeedbackRecord['origin'] } = {},
  ) {}

  decorate(): LarkChannel {
    return new Proxy(this.channel, {
      get: (target, property) => {
        if (property === 'send') return this.send.bind(this);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private async send(chatId: string, input: SendInput, options?: SendOptions): Promise<SendResult> {
    const text = 'markdown' in input ? input.markdown : 'text' in input ? input.text : undefined;
    const kind = text !== undefined ? 'text' : 'file' in input ? 'file' : 'image' in input ? 'image' : undefined;
    if (!kind) return this.channel.send(chatId, input, options);
    let record: FeedbackRecord;
    try {
      const { chatType } = await this.channel.getChatInfo(chatId);
      const origin = this.options.origin?.(chatId, options?.replyTo);
      record = await this.store.create({ chatId, chatType, kind, ...(origin ? { origin } : {}),
        ...(text !== undefined ? { text: text.slice(0, 100_000) } : {}),
        ...('file' in input ? { fileName: input.file.fileName } : {}),
      });
    } catch {
      log.warn('feedback', 'storage-unavailable', {});
      return this.channel.send(chatId, input, options);
    }
    // Preserve native mention handling and large-message chunking.
    const card = text !== undefined ? feedbackCard(record.id, text) : undefined;
    let inline = 'markdown' in input && card !== undefined && Buffer.byteLength(JSON.stringify(card), 'utf8') <= 18_000 && !options?.mentions?.length && !options?.resolveMentionsInText;
    let sent: SendResult;
    try {
      sent = await this.channel.send(chatId, inline ? { card: card! } : input, options);
    } catch (error) {
      // Retry only a definitive formatting rejection, never an ambiguous timeout.
      if (!inline || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'format_error') throw error;
      inline = false;
      sent = await this.channel.send(chatId, input, options);
    }
    try {
      await this.store.mutate(record.id, (item) => { item.messageId = sent.messageId; });
      const feedback = inline ? sent : await this.channel.send(chatId, { card: feedbackCard(record.id) }, {
        replyTo: sent.messageId, ...(options?.replyInThread ? { replyInThread: true } : {}),
      });
      await this.store.mutate(record.id, (item) => { item.feedbackMessageId = feedback.messageId; });
    } catch {
      // Already delivered: a feedback failure must not duplicate the content.
      log.warn('feedback', 'attachment-failed', { id: record.id });
    }
    return sent;
  }

  async handle(event: CardActionEvent): Promise<CardActionResponse> {
    try {
      const value = event.action.value as Record<string, unknown>;
      const id = typeof value.id === 'string' ? value.id : '';
      const actor = event.operator?.openId;
      if (!actor) throw new Error('Missing actor');
      const record = await this.store.read(id);
      if (!this.authorized(actor, record.chatId, record.chatType)) throw new Error('Unauthorized');
      if (value.cmd === 'feedback-reason') {
        const reason = event.action.formValue?.reason;
        const validReason = typeof reason === 'string' && !!reason.trim() && reason.length <= 1000;
        const view = await this.store.mutate(id, (item) => {
          const vote = item.votes.find((entry) => entry.actorId === actor);
          if (!vote || vote.rating !== 'down' || vote.token !== value.token || event.chatId !== item.chatId || !item.feedbackMessageId || event.messageId !== item.feedbackMessageId) {
            throw new Error('Stale or foreign feedback form');
          }
          if (validReason) {
            vote.reason = reason.trim();
            vote.reasonShared = true;
            if (this.options.repair) vote.repairTaskId = digest(`${id}:${actor}:${vote.reason}`);
            vote.updatedAt = new Date().toISOString();
          }
          return this.view(item, vote);
        });
        return { ...toast(validReason ? (this.options.repair ? '原因已保存，修正已排队 / Saved; correction queued' : '原因已保存，谢谢 / Reason saved, thank you') : '请输入 1–1000 字的原因 / Enter a reason (1–1000 characters)', validReason ? 'success' : 'error'), card: { type: 'raw', data: view } };
      }
      const rating = value.rating;
      if (value.cmd !== 'feedback-vote' || (rating !== 'up' && rating !== 'down') ||
          event.chatId !== record.chatId || !record.messageId || event.messageId !== record.feedbackMessageId) {
        throw new Error('Invalid feedback action');
      }
      const actorName = await this.actorName(event, record.chatId);
      const view = await this.store.mutate(id, (item) => {
        const existing = item.votes.find((entry) => entry.actorId === actor);
        if (existing?.rating === rating) {
          if (actorName) existing.actorName = actorName;
          return this.view(item, existing);
        }
        item.votes = item.votes.filter((entry) => entry.actorId !== actor);
        const next: FeedbackVote = { actorId: actor, ...(actorName ? { actorName } : {}), rating, updatedAt: new Date().toISOString(), ...(rating === 'down' ? { token: randomUUID() } : {}) };
        item.votes.push(next);
        return this.view(item, next);
      });
      return { ...toast(rating === 'up' ? '已记录 👍 / 👍 recorded' : '已记录 👎，可在卡片内补充原因 / 👎 recorded; add a reason in this card'), card: { type: 'raw', data: view } };
    } catch {
      return toast('反馈未保存：卡片已失效、无权限或存储暂不可用，请重试 / Feedback not saved: stale card, access denied, or storage unavailable; retry', 'error');
    }
  }

  private async actorName(event: CardActionEvent, chatId: string): Promise<string | undefined> {
    const supplied = event.operator.name?.trim();
    if (supplied) return supplied.slice(0, 80);
    // Card callbacks commonly omit names. Use the SDK's cached roster, but keep
    // name lookup below the callback deadline even if the API is unavailable.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.channel.getChatMembers(chatId).then((members) =>
          members.find((member) => member.id === event.operator.openId)?.name?.trim().slice(0, 80)),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 800); }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private view(record: FeedbackRecord, vote: FeedbackVote): object {
    // Equal message IDs identify inline cards, including records from the DM preview.
    const text = record.messageId === record.feedbackMessageId ? record.text : undefined;
    return feedbackCard(record.id, text, {
      vote, repairEnabled: this.options.repair === true,
      up: record.votes.filter((entry) => entry.rating === 'up').length,
      down: record.votes.filter((entry) => entry.rating === 'down').length,
    });
  }
}
