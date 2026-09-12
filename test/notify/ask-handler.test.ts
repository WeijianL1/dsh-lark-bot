import { describe, expect, it, vi } from 'vitest';
import { buildAskHandler } from '../../src/notify/ask-handler.js';
import { QuestionRegistry } from '../../src/bot/questions.js';
import { SessionStore } from '../../src/session/store.js';
import { ScopeDirectory } from '../../src/bridge/scope-directory.js';

describe('buildAskHandler', () => {
  it('ends unanswered waits gracefully, clears the registry, and closes the stale form', async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionStore(':memory:'); sessions.set('chat', 'session', '/work');
      const directory = new ScopeDirectory(':memory:'); directory.register('chat', 'group', undefined);
      const questions = new QuestionRegistry();
      const updateCard = vi.fn().mockResolvedValue(undefined);
      const sendCard = vi.fn().mockResolvedValue('card');
      const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions, waitMs: 2000, channel: { sendCard, updateCard } });
      const task = handler({ token: '', sessionId: 'session', question: 'Which case?' });
      await vi.advanceTimersByTimeAsync(1999);
      expect(questions.pendingCount('chat')).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await task).toEqual({ ok: false, error: expect.stringContaining('This is not approval or rejection') });
      expect(questions.pendingCount('chat')).toBe(0);
      expect(questions.pendingForMessage('card')).toBeUndefined();
      const rendered = JSON.stringify(updateCard.mock.calls[0]?.[1]);
      expect(rendered).toContain('已结束等待');
      expect(rendered).not.toContain('question-submit');
    } finally { vi.useRealTimers(); }
  });

  it('bounds stalled delivery and closes a card that arrives after the delivery deadline', async () => {
    vi.useFakeTimers();
    try {
      const sessions = new SessionStore(':memory:'); sessions.set('chat', 'session', '/work');
      const directory = new ScopeDirectory(':memory:'); directory.register('chat', 'group', undefined);
      const questions = new QuestionRegistry(); let deliver!: (id: string) => void;
      const updateCard = vi.fn().mockResolvedValue(undefined);
      const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions, deliveryMs: 1000,
        channel: { sendCard: () => new Promise((resolve) => { deliver = resolve; }), updateCard } });
      const task = handler({ token: '', sessionId: 'session', question: 'Q' });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await task).ok).toBe(false);
      expect(questions.pendingCount('chat')).toBe(0);
      deliver('late-card'); await vi.advanceTimersByTimeAsync(0);
      expect(updateCard).toHaveBeenCalledWith('late-card', expect.any(Object));
      expect(questions.pendingForMessage('late-card')).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('cancels immediately during stalled delivery and closes the late card', async () => {
    const sessions = new SessionStore(':memory:'); sessions.set('chat', 'session', '/work');
    const directory = new ScopeDirectory(':memory:'); directory.register('chat', 'group', undefined);
    const questions = new QuestionRegistry(); let deliver!: (id: string) => void;
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions,
      channel: { sendCard: () => new Promise((resolve) => { deliver = resolve; }), updateCard } });
    const controller = new AbortController();
    const task = handler({ token: '', sessionId: 'session', question: 'Q' }, controller.signal);
    controller.abort();
    expect(await task).toEqual({ ok: false, error: 'question cancelled' });
    expect(questions.pendingCount('chat')).toBe(0);
    deliver('late'); await Promise.resolve();
    expect(updateCard).toHaveBeenCalledWith('late', expect.any(Object));
    expect(questions.pendingForMessage('late')).toBeUndefined();
  });

  it('does not label an early answer unanswered when its delivery receipt arrives late', async () => {
    const sessions = new SessionStore(':memory:'); sessions.set('chat', 'session', '/work');
    const directory = new ScopeDirectory(':memory:'); directory.register('chat', 'group', undefined);
    const questions = new QuestionRegistry(); let deliver!: (id: string) => void;
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn(() => new Promise<string>((resolve) => { deliver = resolve; }));
    const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions, channel: { sendCard, updateCard } });
    const task = handler({ token: '', sessionId: 'session', question: 'Q' });
    const cardId = /"id":"([^"]+)"/.exec(JSON.stringify(sendCard.mock.calls[0]))?.[1];
    expect(cardId).toBeTruthy();
    questions.resolve('chat', cardId!, 'Answer');
    expect(await task).toEqual({ ok: true, answer: 'Answer' });
    deliver('late'); await Promise.resolve();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('never waits for a question without a delivery receipt', async () => {
    const sessions = new SessionStore(':memory:'); sessions.set('chat', 'session', '/work');
    const directory = new ScopeDirectory(':memory:'); directory.register('chat', 'group', undefined);
    const questions = new QuestionRegistry();
    const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions, channel: { sendCard: vi.fn().mockResolvedValue(undefined) } });
    expect(await handler({ token: '', sessionId: 'session', question: 'Q' })).toEqual({ ok: false, error: expect.stringContaining('no message receipt') });
    expect(questions.pendingCount('chat')).toBe(0);
  });

  it('routes a session to its chat, sends a question card and returns the answer', async () => {
    const sessions = new SessionStore(':memory:');
    sessions.set('chat-a', 'session-1', '/tmp/project');
    const directory = new ScopeDirectory(':memory:');
    directory.register('chat-a', 'oc_group', 'oc_thread', 'topic', 'om_anchor');
    const questions = new QuestionRegistry();
    const sendCard = vi.fn().mockResolvedValue('question-card-message');

    const handler = buildAskHandler({ sessions, scopeDirectory: directory, questions, channel: { sendCard } });
    const answerPromise = handler({
      token: 't',
      sessionId: 'session-1',
      question: 'Which plan?',
      kind: 'single',
      options: ['A', 'B'],
    });

    // The card is sent before the handler waits for the answer.
    expect(sendCard).toHaveBeenCalledOnce();
    const card = sendCard.mock.calls[0] as [string, object, unknown];
    expect(card[0]).toBe('oc_group');
    expect(card[2]).toEqual({ threadId: 'oc_thread', replyTo: 'om_anchor' });
    // Resolve the registered question the way the card submit path does.
    const registered = JSON.stringify(sendCard.mock.calls[0]?.[1] ?? {});
    const cardId = /"id":"([^"]+)"/.exec(registered)?.[1];
    expect(cardId).toBeTruthy();
    await vi.waitFor(() => {
      expect(questions.pendingForMessage('question-card-message')?.id).toBe(cardId);
    });
    questions.resolve('chat-a', cardId!, 'A');

    await expect(answerPromise).resolves.toEqual({ ok: true, answer: 'A' });
  });

  it('rejects unknown sessions', async () => {
    const sessions = new SessionStore(':memory:');
    const directory = new ScopeDirectory(':memory:');
    const handler = buildAskHandler({
      sessions,
      scopeDirectory: directory,
      questions: new QuestionRegistry(),
      channel: { sendCard: vi.fn() },
    });
    await expect(
      handler({ token: 't', sessionId: 'nope', question: 'Q' }),
    ).resolves.toEqual({ ok: false, error: 'unknown session: nope' });
  });

  it('settles pending questions when the card cannot be sent', async () => {
    const sessions = new SessionStore(':memory:');
    sessions.set('chat-a', 'session-1', '/tmp/project');
    const directory = new ScopeDirectory(':memory:');
    directory.register('chat-a', 'oc_group', undefined);
    const questions = new QuestionRegistry();
    const sendCard = vi.fn().mockRejectedValue(new Error('send failed'));
    const handler = buildAskHandler({
      sessions,
      scopeDirectory: directory,
      questions,
      channel: { sendCard },
    });
    await expect(
      handler({ token: 't', sessionId: 'session-1', question: 'Q' }),
    ).resolves.toEqual({ ok: false, error: 'send failed' });
    expect(questions.pendingCount('chat-a')).toBe(0);
  });

  it('cancels the exact pending question when its callback disconnects', async () => {
    const sessions = new SessionStore(':memory:');
    sessions.set('chat-a', 'session-1', '/tmp/project');
    const directory = new ScopeDirectory(':memory:');
    directory.register('chat-a', 'oc_group', undefined);
    const questions = new QuestionRegistry();
    const sendCard = vi.fn().mockResolvedValue('question-card-message');
    const handler = buildAskHandler({
      sessions,
      scopeDirectory: directory,
      questions,
      channel: { sendCard },
    });
    const controller = new AbortController();

    const result = handler(
      { token: 't', sessionId: 'session-1', question: 'Q' },
      controller.signal,
    );
    await vi.waitFor(() => expect(questions.pendingCount('chat-a')).toBe(1));
    controller.abort();

    await expect(result).resolves.toEqual({ ok: false, error: 'question cancelled' });
    expect(questions.pendingCount('chat-a')).toBe(0);
  });

  it('does not cancel another session question when one card send fails', async () => {
    const sessions = new SessionStore(':memory:');
    sessions.set('chat-a', 'session-b', '/tmp/project');
    const directory = new ScopeDirectory(':memory:');
    directory.register('chat-a', 'oc_group', undefined);
    const questions = new QuestionRegistry();
    const first = questions.register('chat-a', { kind: 'text', question: 'Q1' }, 'session-a');
    questions.bindMessage('chat-a', first.id, 'card-a');
    const handler = buildAskHandler({
      sessions,
      scopeDirectory: directory,
      questions,
      channel: { sendCard: vi.fn().mockRejectedValue(new Error('send failed')) },
    });

    await handler({ token: 't', sessionId: 'session-b', question: 'Q2' });

    expect(questions.pendingForMessage('card-a')?.id).toBe(first.id);
    questions.resolve('chat-a', first.id, 'still active');
    await expect(first.promise).resolves.toBe('still active');
  });
});
