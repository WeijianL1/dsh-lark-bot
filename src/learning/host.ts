import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationEvidence, LearningIdentity } from './journal.js';
import { log } from '../core/logger.js';

interface Message { id?: string; role?: string; source?: { kind?: string; rpcId?: string }; content?: Array<{ type?: string; text?: string }> }
interface Session { id: string; header?: { cwd?: string; origin?: string } }
interface Agent { id: string; session: Session; ctx: Context }
export interface ConversationLearningPort {
  resolve(sessionId: string, workspace: string, rpcId?: string): (LearningIdentity & { originalText?: string }) | undefined;
  observe(input: Omit<ConversationEvidence, 'key' | 'recordId'>): Promise<void>;
  recall(identity: LearningIdentity): Promise<string>;
  activity(identity: LearningIdentity, sessionId: string, active: boolean): void;
}
const textOf = (message: Message) => (message.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');

/** Host lifecycle adapter: only actual user messages; no transcript polling or assistant self-learning. */
export function attachConversationLearning(ctx: Context, port: ConversationLearningPort): () => Promise<void> {
  const stops: Array<() => void> = [];
  const installed = new Set<string>();
  let tail = Promise.resolve();
  let closed = false;
  const enqueue = (operation: () => Promise<void>) => {
    tail = tail.then(async () => { await operation(); }).catch(() => { log.warn('conversation-learning', 'capture-unavailable', {}); });
  };
  const install = (agent: Agent) => {
    if (installed.has(agent.id) || agent.session.header?.origin === 'subagent') return;
    installed.add(agent.id);
    const activityId = `${agent.session.id}:${randomUUID()}`;
    let pending: Array<Omit<ConversationEvidence, 'key' | 'recordId'>> = [];
    let prior: { actor: string; chat: string; answer: string } | undefined;
    let answer = '';
    let activityVersion = 0;
    const busy = new Map<string, LearningIdentity>();
    const clearBusy = () => { for (const identity of busy.values()) port.activity(identity, activityId, false); busy.clear(); };
    stops.push(clearBusy);
    const events = agent.ctx as unknown as { on(name: string, callback: (...args: any[]) => any): () => void };
    stops.push(events.on('agent/pre-step', async (payload: { step: number; signal: AbortSignal }, next: () => Promise<{ kind: string; messages: Message[] }>) => {
      const decision = await next();
      if (closed || decision.kind !== 'enter' || payload.step !== 1 || payload.signal.aborted) return decision;
      const workspace = agent.session.header?.cwd;
      if (!workspace) return decision;
      activityVersion += 1;
      const identities: LearningIdentity[] = [];
      for (const message of decision.messages) {
        if (message.role !== 'user' || message.source?.kind !== 'user' || !message.id) continue;
        const identity = port.resolve(agent.session.id, workspace, message.source.rpcId);
        if (!identity) continue;
        const reason = (identity.originalText ?? textOf(message)).trim();
        if (!reason || reason.startsWith('/') || reason.length > 12_000) continue;
        pending.push({ ...identity, sessionId: agent.session.id, messageId: message.id, reason, createdAt: Date.now(),
          ...(prior?.actor === identity.actorId && prior.chat === identity.chatId ? { answer: prior.answer.slice(0, 2500) } : {}) });
        identities.push(identity);
        busy.set(JSON.stringify([identity.chatId, identity.actorId, identity.workspace]), identity);
        port.activity(identity, activityId, true);
      }
      // A mixed-actor queued turn must not inject one person's lessons into another's context.
      if (identities.length && identities.every(i => i.actorId === identities[0]!.actorId && i.chatId === identities[0]!.chatId)) {
        const identity = identities[0]!;
        if (identity.transport === 'local') {
          try {
            const memory = await port.recall(identity);
            if (memory) return { ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user', source: { kind: 'plugin', plugin: 'dsh-conversation-learning', form: 'recall' }, content: [{ type: 'text', text: `Scoped learned preferences and lessons. Apply only when relevant; current user instructions take precedence.\n${memory}` }] }] };
          } catch { log.warn('conversation-learning', 'recall-unavailable', {}); }
        }
      }
      return decision;
    }));
    stops.push(events.on('session/event', (session: Session, event: { type: string; data?: { message?: Message } }) => {
      if (session !== agent.session || closed) return;
      if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') answer = textOf(event.data.message).slice(0, 2500);
      if (event.type !== 'turn/end') return;
      const completed = pending; pending = [];
      const completedVersion = activityVersion;
      const owners = new Set(completed.map(i => `${i.chatId}:${i.actorId}`));
      prior = owners.size === 1 && completed.length ? { actor: completed[0]!.actorId, chat: completed[0]!.chatId, answer } : undefined;
      answer = '';
      enqueue(async () => { try { for (const input of completed) await port.observe({ ...input, createdAt: Date.now() }); } finally { if (activityVersion === completedVersion) clearBusy(); } });
    }));
    stops.push(events.on('agent/session-start', () => { pending = []; prior = undefined; answer = ''; clearBusy(); }));
  };
  const injection = ctx.inject(['agents'], (injected) => {
    const host = injected as unknown as { agents: { roots(): Agent[] }; on(name: string, callback: (payload: { agent: Agent }) => void): () => void };
    const start = stops.length;
    const off = host.on('agent/created', ({ agent }) => install(agent));
    for (const agent of host.agents.roots()) install(agent);
    return () => { off(); for (const stop of stops.splice(start).reverse()) stop(); installed.clear(); };
  });
  return async () => { closed = true; for (const stop of stops.reverse()) stop(); await injection.dispose(); await tail; };
}
