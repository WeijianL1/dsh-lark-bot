import type { Context } from '@deepseek-ai/cordis';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { WebDshAdapter, type WebAdapterOptions } from './web-adapter.js';

/** Use the loaded Host's public Session service: one writer, no browser auth bypass. */
export class HostDshAdapter extends WebDshAdapter {
  private readonly controller: SessionController;
  private readonly streams = new Set<WebSocket>();

  constructor(private readonly host: Context, options: WebAdapterOptions) {
    super(options);
    const controller = host.get('sessionController');
    if (!controller) throw new Error('DSH Session controller is unavailable');
    this.controller = controller;
  }

  override async rpc<T = unknown>(method: string, raw: unknown, rpcId?: string): Promise<T> {
    const payload = raw as Record<string, unknown>;
    const sessionId = payload.sessionId as SessionId;
    let value: unknown;
    switch (method) {
      case 'session.create': value = await this.controller.create(payload); break;
      case 'session.list': value = await this.controller.list({}, AbortSignal.timeout(15_000)); break;
      case 'session.prompt': value = await this.controller.prompt({ ...payload, sessionId,
        requestId: rpcId as Parameters<SessionController['prompt']>[0]['requestId'],
      } as Parameters<SessionController['prompt']>[0], AbortSignal.timeout(30_000)); break;
      case 'session.cancel': value = await this.controller.cancel({ sessionId }); break;
      case 'session.history': {
        const signal = new AbortController();
        const timeout = setTimeout(() => signal.abort(new Error('Session history timed out')), 15_000);
        const address = { kind: 'session' as const, sessionId };
        const iterator = this.controller.follow({ address, maxMessages: Number(payload.maxMessages ?? 50) }, signal.signal)[Symbol.asyncIterator]();
        try {
          const opening = await iterator.next();
          if (opening.done || opening.value.type !== 'snapshot') throw new Error('Session history snapshot missing');
          const snapshot = opening.value;
          const page = payload.beforeSeq === undefined ? snapshot : await this.controller.page({ address, throughSeq: snapshot.cursor,
            beforeSeq: Number(payload.beforeSeq), maxMessages: Number(payload.maxMessages ?? 50),
          }, signal.signal);
          value = { events: page.records, hasMore: page.hasMore };
        } finally { clearTimeout(timeout); signal.abort(); await iterator.return?.(); }
        break;
      }
      default: throw new Error(`Unsupported Host session operation: ${method}`);
    }
    return { result: { ok: true, value } } as T;
  }

  override async openMux(): Promise<WebSocket> {
    const target = new EventTarget();
    let closed = false;
    const publish = (sessionId: string, event: unknown) => {
      if (!closed) target.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ payload: { type: 'session/event', sessionId, event } }) }));
    };
    const stopEvents = this.host.on('session/event', (session, event) => publish(session.id, event));
    const stopStream = this.host.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type === 'chunk') publish(agent.session.id, { type: 'assistant/chunk', data: { chunk: frame.chunk } });
    });
    const stop = () => { stopEvents(); stopStream(); };
    const socket = Object.assign(target, { close: () => {
      if (closed) return;
      closed = true; stop(); this.streams.delete(socket as unknown as WebSocket);
      target.dispatchEvent(new Event('close'));
    } }) as unknown as WebSocket;
    this.streams.add(socket);
    return socket;
  }

  override async checkAvailability() {
    return { ok: true, error: undefined, version: 'dsh-host@0.2.0-rc.2' };
  }

  override async dispose(): Promise<void> {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    await super.dispose();
  }
}
