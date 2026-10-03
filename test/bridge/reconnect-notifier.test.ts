import { describe, expect, it, vi } from 'vitest';
import { ReconnectNotifier } from '../../src/bridge/reconnect-notifier.js';
import { ScopeDirectory } from '../../src/bridge/scope-directory.js';

describe('ReconnectNotifier', () => {
  it('stays silent in Feishu throughout reconnect and forwards fault events out of band', async () => {
    const directory = new ScopeDirectory(':memory:');
    directory.register('older', 'chat-old', undefined, 'p2p', 'old-message');
    await new Promise((resolve) => setTimeout(resolve, 2));
    directory.register('recent', 'chat-new', 'thread-1', 'topic', 'anchor-1');
    const onFault = vi.fn().mockResolvedValue(undefined);
    let now = 1_000;
    const notifier = new ReconnectNotifier(
      directory,
      () => now,
      () => ({
        zhCn: '账本：queued 2 · interrupted 1',
        enUs: 'Ledger: queued 2 · interrupted 1',
      }),
      onFault,
    );

    await notifier.reconnecting();
    expect(onFault).toHaveBeenCalledWith(
      'recent',
      expect.objectContaining({ zh: expect.stringContaining('正在自动重连') }),
    );

    now = 4_600;
    await notifier.reconnected();

    expect(onFault).toHaveBeenCalledTimes(2);
    expect(onFault).toHaveBeenLastCalledWith(
      'recent',
      expect.objectContaining({ zh: expect.stringMatching(/连接已恢复[\s\S]*4 秒[\s\S]*queued 2/) }),
    );
  });

  it('does nothing when recovery is observed without a reconnect episode', async () => {
    const onFault = vi.fn().mockResolvedValue(undefined);
    await new ReconnectNotifier(undefined, Date.now, undefined, onFault).reconnected();
    expect(onFault).not.toHaveBeenCalled();
  });
});
