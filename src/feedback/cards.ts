import { randomUUID } from 'node:crypto';
import { localizedCard, type CardLocale } from '../card/i18n.js';
import type { FeedbackVote } from './store.js';

export interface FeedbackView {
  vote: FeedbackVote;
  up: number;
  down: number;
  repairEnabled?: boolean;
}

/** Shared card: highlight the named last voter, not a viewer-specific selection. */
export function feedbackCard(id: string, text?: string, view?: FeedbackView): object {
  // The channel SDK deduplicates serialized action values; each rendered card needs a fresh key.
  const revision = randomUUID();
  const body = (locale: CardLocale) => ({ elements: [
    ...(text ? [{ tag: 'markdown', content: text }, { tag: 'hr' }] : []),
    { tag: 'div', text: { tag: 'plain_text', text_size: 'notation', text_color: 'grey', content: locale === 'zh_cn' ? '回答反馈 · 帮助改进下一次回答' : 'FEEDBACK · Help improve the next answer' } },
    ...(view ? [{ tag: 'div', text: { tag: 'plain_text', text_size: 'notation', text_color: 'grey', content: locale === 'zh_cn'
      ? `最近投票：${view.vote.actorName ?? '投票用户'} · ${view.vote.rating === 'up' ? '👍' : '👎'}`
      : `Latest vote: ${view.vote.actorName ?? 'Voter'} · ${view.vote.rating === 'up' ? '👍' : '👎'}` } }] : []),
    { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', background_style: 'grey', margin: '4px 0px',
      columns: (['up', 'down'] as const).map((rating) => ({
        tag: 'column', width: 'auto', vertical_align: 'center', elements: [{
          tag: 'button', type: view?.vote.rating === rating ? 'primary' : 'default',
          text: { tag: 'plain_text', content: `${view?.vote.rating === rating ? '✓ ' : ''}${rating === 'up' ? '👍' : '👎'}${view ? ` ${view[rating]}` : ''}` },
          value: { revision, cmd: 'feedback-vote', id, rating },
        }],
      })),
    },
    ...(view?.vote.reasonShared && view.vote.reason ? [{ tag: 'div', text: { tag: 'plain_text', content:
      `${locale === 'zh_cn' ? `已保存原因（${view.vote.actorName ?? '投票用户'}）` : `Saved reason (${view.vote.actorName ?? 'Voter'})`}: ${view.vote.reason.slice(0, 200)}${view.vote.reason.length > 200 ? '…' : ''}` } }] : []),
    ...(view?.vote.rating === 'down' && view.vote.token ? [
      { tag: 'markdown', content: locale === 'zh_cn'
        ? (view.repairEnabled ? '哪里可以改进？提交后会根据原回答和原因生成修正版。' : '哪里可以改进？可选填，最多 1000 字，群内可见。')
        : (view.repairEnabled ? 'What could be better? Submit to request a revised answer.' : 'Optional reason · up to 1000 characters · visible to the chat.') },
      { tag: 'form', name: 'feedback-reason', elements: [
        { tag: 'input', name: 'reason', max_length: 1000, placeholder: { tag: 'plain_text', content: locale === 'zh_cn' ? '哪里不好？' : 'What could be better?' } },
        { tag: 'button', name: 'submit-reason', type: 'primary', form_action_type: 'submit',
          text: { tag: 'plain_text', content: locale === 'zh_cn' ? (view.repairEnabled ? '提交并修正' : '提交反馈') : (view.repairEnabled ? 'Submit & revise' : 'Submit feedback') },
          value: { revision, cmd: 'feedback-reason', id, token: view.vote.token } },
      ] },
    ] : []),
  ] });
  return localizedCard({ config: { update_multi: true }, zhCn: { summary: text?.slice(0, 80) ?? '评价这条内容', body: body('zh_cn') }, enUs: { summary: text?.slice(0, 80) ?? 'Rate this content', body: body('en_us') } });
}
