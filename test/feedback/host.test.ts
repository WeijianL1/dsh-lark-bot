import { Context, Service } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import { bindFeedbackGenerator, type FeedbackGenerate } from '../../src/feedback/generate.js';

it('resolves the model from a plugin context with optional service injection', async () => {
  const root = new Context();
  try {
    await root.plugin(class extends Service {
      constructor(ctx: Context) { super(ctx, 'llm'); }
      async *stream() { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    });
    let generate: FeedbackGenerate;
    await root.plugin((ctx) => { generate = bindFeedbackGenerator(ctx); });
    await expect(generate!({ provider: 'test', model: 'test', system: '', prompt: '', signal: new AbortController().signal })).resolves.toBe('OK');
  } finally { await root.fiber.dispose(); }
});

it('waits for late model registration and clears the service when unloaded', async () => {
  const root = new Context();
  const request = { provider: 'test', model: 'test', system: '', prompt: '', signal: new AbortController().signal };
  try {
    let generate: FeedbackGenerate;
    await root.plugin((ctx) => { generate = bindFeedbackGenerator(ctx); });
    await expect(generate!(request)).rejects.toThrow('service unavailable');
    const provider = root.plugin(class extends Service {
      constructor(ctx: Context) { super(ctx, 'llm'); }
      async *stream() { yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    });
    await provider;
    await expect(generate!(request)).resolves.toBe('OK');
    await provider.dispose();
    await expect(generate!(request)).rejects.toThrow('service unavailable');
  } finally { await root.fiber.dispose(); }
});
