export type QuestionKind = 'single' | 'multi' | 'text';

export interface QuestionCardInput {
  id: string;
  kind: QuestionKind;
  question: string;
  options?: string[];
  placeholder?: string;
  actionScope?: string;
  waitSeconds?: number;
}

function formElement(input: QuestionCardInput, locale: CardLocale): object {
  if (input.kind === 'text') {
    return {
      tag: 'input',
      name: 'answer',
      placeholder: { tag: 'plain_text', content: input.placeholder ?? (locale === 'zh_cn' ? '请输入答案…' : 'Enter an answer…') },
    };
  }
  const options = (input.options ?? []).map((option, index) => ({
    text: { tag: 'plain_text', content: option },
    value: `option-${index}`,
  }));
  if (input.kind === 'multi') {
    return {
      tag: 'multi_select_static',
      name: 'answer',
      placeholder: { tag: 'plain_text', content: locale === 'zh_cn' ? '请选择（可多选）…' : 'Choose one or more…' },
      options,
    };
  }
  return {
    tag: 'select_static',
    name: 'answer',
    placeholder: { tag: 'plain_text', content: locale === 'zh_cn' ? '请选择…' : 'Choose…' },
    options,
  };
}

/**
 * Structured question card: single choice, multi choice, or free text.
 * The input/select and its submit button are wrapped in a `form` container —
 * schema 2.0 only returns the selected/filled value in the callback when the
 * interactive component lives inside a form with a submit-bound button.
 */
export function renderQuestionCard(input: QuestionCardInput): object {
  const body = (locale: CardLocale) => ({
      elements: [
        { tag: 'markdown', content: `❓ ${input.question}` },
        ...(input.waitSeconds ? [{ tag: 'markdown', content: locale === 'zh_cn'
          ? `正在等待你的补充，最多等待 ${input.waitSeconds} 秒。未答复会结束本轮等待；之后可 @ 我补充信息继续。`
          : `Waiting for your input for up to ${input.waitSeconds} seconds. Afterwards, mention me with the missing information to continue.` }] : []),
        {
          tag: 'markdown',
          content: locale === 'zh_cn'
            ? '💬 也可以直接回复本卡片作答；选项不合适时可输入补充说明。'
            : '💬 You can also reply directly to this card; add a free-form note if the options do not fit.',
        },
        {
          tag: 'form',
          name: `form-${input.id}`,
          elements: [
            formElement(input, locale),
            {
              tag: 'button',
              text: { tag: 'plain_text', content: locale === 'zh_cn' ? '提交' : 'Submit' },
              type: 'primary',
              value: {
                cmd: 'question-submit',
                id: input.id,
                ...(input.actionScope ? { scope: input.actionScope } : {}),
              },
              form_action_type: 'submit',
              name: `btn-submit-${input.id}`,
            },
          ],
        },
      ],
    });
  return localizedCard({
    zhCn: { summary: '问题', body: body('zh_cn') },
    enUs: { summary: 'Question', body: body('en_us') },
  });
}

/**
 * Normalize a card action value into an answer for the question kind.
 * `answer` shapes: string (text / single select) or string[] (multi select).
 */
export function extractQuestionAnswer(
  kind: QuestionKind,
  value: unknown,
  options?: string[],
): string | string[] | undefined {
  const answer = value;
  if (kind === 'text') {
    return typeof answer === 'string' && answer.trim() ? answer.trim() : undefined;
  }
  const selected = Array.isArray(answer)
    ? answer.map((item) => String(item))
    : typeof answer === 'string' && answer
      ? [answer]
      : [];
  if (selected.length === 0) return undefined;
  const labels = options ?? [];
  const resolved = selected.map((item) => {
    const match = /^option-(\d+)$/.exec(item);
    if (match) {
      const index = Number(match[1]);
      return labels[index] ?? item;
    }
    return item;
  });
  return kind === 'single' ? resolved[0] : resolved;
}
import { localizedCard, type CardLocale } from './i18n.js';

/** Expired question is visibly closed: never leave an active-looking dead form. */
export function renderExpiredQuestion(input: QuestionCardInput): object {
  return localizedCard({
    zhCn: { summary: '已结束等待', body: { elements: [{ tag: 'markdown', content: `⏸ **已结束等待**\n\n${input.question}\n\n尚未收到答复，没有替你作出选择。请 @ 我补充上述信息，继续处理。` }] } },
    enUs: { summary: 'Waiting ended', body: { elements: [{ tag: 'markdown', content: `⏸ **Waiting ended**\n\n${input.question}\n\nNo answer was received and no choice was assumed. Mention me with the missing information to continue.` }] } },
  });
}
