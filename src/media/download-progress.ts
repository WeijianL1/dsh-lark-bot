import type { StreamingChannel } from '../bridge/types.js';

/** A separate, throttled attachment card; delivery cannot fail the download. */
export function downloadProgress(channel: StreamingChannel, source: { chatId: string; messageId: string; threadId?: string }) {
  let messageId: string | undefined;
  let chain = Promise.resolve();
  let lastUpdate = 0;
  let started = false;
  let latest = '';
  function publish(text: string, terminal = false) {
    latest = text;
    const snapshot = text;
    chain = chain.then(async () => {
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: terminal ? '附件处理' : '正在下载附件' }, template: terminal ? 'grey' : 'blue' },
        elements: [{ tag: 'markdown', content: snapshot }],
      };
      if (messageId && channel.updateCard) await channel.updateCard(messageId, card);
      else if (!started && channel.sendCard) {
        started = true;
        messageId = await channel.sendCard(source.chatId, card, {
          replyTo: source.messageId, ...(source.threadId ? { threadId: source.threadId } : {}),
        });
      }
    }).catch(() => undefined);
  }
  return {
    update(done: number, total: number) {
      if (total < 32 * 1024 ** 2) return;
      if (lastUpdate && Date.now() - lastUpdate < 5000 && done !== total) return;
      lastUpdate = Date.now();
      publish(`**${Math.floor(done / total * 100)}%** · ${(done / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MiB\n可以继续聊天。发送 \`/stop\` 可取消；重新处理同一附件时会续传。`);
    },
    async finish(success: boolean) {
      if (latest) publish(success ? '附件已下载，正在交给助手读取。' : '附件处理已停止，已完成的分块会保留用于续传。', true);
      // Card delivery is best effort and must never hold the attachment job open.
    },
  };
}
