import { renderQuestionCard, renderExpiredQuestion, type QuestionCardInput, type QuestionKind } from '../card/question-card.js';
import { log } from '../core/logger.js';
import type { QuestionRegistry } from '../bot/questions.js';
import type { SessionStore } from '../session/store.js';
import type { ScopeDirectory } from '../bridge/scope-directory.js';
import type { SendOptions } from '../bridge/send-options.js';

export interface AskPayload {
  token: string;
  sessionId: string;
  question: string;
  kind?: QuestionKind;
  options?: string[];
  header?: string;
}

export interface AskResult {
  ok: boolean;
  answer?: string | string[] | null;
  error?: string;
}

export const QUESTION_WAIT_MS = 120_000;
export const QUESTION_DELIVERY_MS = 15_000;

export interface AskHandlerDeps {
  waitMs?: number;
  deliveryMs?: number;
  sessions: SessionStore;
  scopeDirectory: ScopeDirectory;
  questions: QuestionRegistry;
  channel: {
    updateCard?(messageId: string, card: object): Promise<void>;
    sendCard(chatId: string, card: object, options?: SendOptions): Promise<string | undefined>;
  };
}

/**
 * Route one `lark_ask_user` tool request to a Feishu/Lark question card and
 * wait for the human answer. The runtime tool identifies itself by its dsh
 * session id, which the bridge records per scope at run start; the scope is
 * resolved to the chat/thread the card is sent to.
 */
export function buildAskHandler(
  deps: AskHandlerDeps,
): (payload: AskPayload, signal?: AbortSignal) => Promise<AskResult> {
  return async (payload, signal) => {
    const scope = deps.sessions.scopeForSession(payload.sessionId);
    if (!scope) {
      return { ok: false, error: `unknown session: ${payload.sessionId}` };
    }
    const destination = deps.scopeDirectory.resolve(scope);
    if (!destination) {
      return { ok: false, error: `unknown scope: ${scope}` };
    }
    const kind =
      payload.kind ?? (payload.options && payload.options.length > 0 ? 'single' : 'text');
    const input: Omit<QuestionCardInput, 'id'> = {
      kind,
      question: payload.question,
      ...(payload.options && payload.options.length > 0
        ? { options: payload.options }
        : {}),
    };
    if (signal?.aborted) return { ok: false, error: 'question cancelled' };
    const waitMs = deps.waitMs ?? QUESTION_WAIT_MS;
    const { id, promise } = deps.questions.register(scope, input, payload.sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let cardId: string | undefined;
    let closed = false;
    let expired = false;
    let answered = false;
    const started = Date.now();
    const closeCard = (messageId: string): void => {
      void deps.channel.updateCard?.(messageId, renderExpiredQuestion({ ...input, id })).catch(() => {
        log.warn('ask-card', 'expiry-update-failed', { scope });
      });
    };
    const cancel = (): void => {
      deps.questions.cancel(scope, id);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    // Abort may have happened after the check above but before listener
    // registration. EventTarget does not replay an already-fired abort.
    if (signal?.aborted) cancel();
    try {
      if (signal?.aborted) return { ok: false, error: 'question cancelled' };
      try {
        const delivery = deps.channel.sendCard(
          destination.chatId,
          renderQuestionCard({ ...input, id, actionScope: scope, waitSeconds: Math.ceil(waitMs / 1000) }),
          destination.messageId ? { replyTo: destination.messageId, ...(destination.threadId ? { threadId: destination.threadId } : {}) } : undefined,
        ).then((messageId) => {
          if (!messageId) throw new Error('Question card delivery returned no message receipt');
          cardId = messageId;
          if (closed || signal?.aborted) { if (!answered) closeCard(messageId); return; }
          deps.questions.bindMessage(scope, id, messageId);
        });
        await Promise.race([delivery, promise.then((answer) => { answered = answer !== undefined; }), new Promise<never>((_, reject) => {
          deliveryTimer = setTimeout(() => reject(new Error('Question card delivery was not confirmed before the deadline; do not assume an answer')), deps.deliveryMs ?? QUESTION_DELIVERY_MS);
        })]);
        clearTimeout(deliveryTimer);

      } catch (error) {
        log.fail('ask-card', error, { scope });
        deps.questions.cancel(scope, id);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!signal?.aborted) {
        timer = setTimeout(() => { expired = true; deps.questions.cancel(scope, id); }, waitMs);
        timer.unref?.();
      }
      const answer = await promise;
      log.info('ask', 'settled', { scope, sessionId: payload.sessionId, outcome: expired ? 'no-answer' : answer === undefined ? 'cancelled' : 'answered', elapsedMs: Date.now() - started });
      if (expired) {
        if (cardId) closeCard(cardId);
        return { ok: false, error: 'No user answer was received within the waiting period. This is not approval or rejection. Do not ask the same question again in this turn or guess an answer. End this turn with the missing information briefly stated; the user can mention the bot later to continue.' };
      }
      if (answer === undefined) {
        if (cardId) closeCard(cardId);
        return { ok: false, error: 'question cancelled' };
      }
      return { ok: true, answer };
    } finally {
      closed = true;
      clearTimeout(timer);
      clearTimeout(deliveryTimer);
      deps.questions.cancel(scope, id);
      signal?.removeEventListener('abort', cancel);
    }
  };
}
