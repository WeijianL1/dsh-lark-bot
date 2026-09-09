import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';

export interface FeedbackGeneration {
  system: string;
  prompt: string;
  provider: string;
  model: string;
  signal: AbortSignal;
  maxTokens?: number;
}
export type FeedbackGenerate = (request: FeedbackGeneration) => Promise<string>;
export interface FeedbackLlmHost {
  stream(options: Record<string, unknown>): AsyncIterable<{
    type: string; text?: string; reason?: { kind: string };
  }>;
}

/** One model call, with no tool schemas and no agent/tool dispatcher. */
export function feedbackGenerator(host: () => FeedbackLlmHost | undefined): FeedbackGenerate {
  return async (request) => {
    const llm = host();
    if (!llm) throw new Error('Feedback model service unavailable');
    let text = '';
    let finished = false;
    for await (const chunk of llm.stream({
      provider: request.provider, model: request.model, system: request.system,
      messages: [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request.prompt }] }],
      tools: [], maxTokens: request.maxTokens ?? 2048, signal: request.signal,
    })) {
      if (request.signal.aborted) throw new Error('Feedback generation cancelled');
      if (chunk.type === 'tool-call-delta') throw new Error('Feedback generation cannot execute tools');
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      if (Buffer.byteLength(JSON.stringify({ text }), 'utf8') > 24_000) throw new Error('Feedback output too large');
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind !== 'stop') throw new Error('Feedback generation did not complete');
        finished = true;
      }
    }
    if (!finished || !text.trim()) throw new Error('Feedback generation returned no complete answer');
    return text.trim();
  };
}

/** Capture the service only inside an injected context; a bare plugin context forbids access. */
export function bindFeedbackGenerator(ctx: Context): FeedbackGenerate {
  let current: FeedbackLlmHost | undefined;
  ctx.inject(['llm'], (injected) => {
    const service = (injected as unknown as { llm: FeedbackLlmHost }).llm;
    current = service;
    return () => { if (current === service) current = undefined; };
  });
  return feedbackGenerator(() => current);
}
