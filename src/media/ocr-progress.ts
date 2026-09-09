import type { StreamingChannel } from '../bridge/types.js';
import type { OcrEvent } from './pdf-ocr.js';

export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: number[][] = [];
  for (const page of sorted) {
    const last = ranges.at(-1);
    if (last && last[1]! + 1 === page) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges.map(([a, b]) => a === b ? String(a) : `${a}–${b}`).join('、');
}

/** Coalesce updates and never make processing wait for a card API. */
export function ocrProgress(channel: StreamingChannel, source: { chatId: string; messageId: string; threadId?: string }, fileName: string) {
  let cardId: string | undefined;
  let pending: object | undefined;
  let busy = false;
  let last = 0;
  let total = 0, done = 0;
  let review: number[] = [];
  let terminal = false;
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (pending) {
        const card = pending; pending = undefined;
        try {
          if (cardId && channel.updateCard) await channel.updateCard(cardId, card);
          else if (channel.sendCard) cardId = await channel.sendCard(source.chatId, card, {
            replyTo: source.messageId, ...(source.threadId ? { threadId: source.threadId } : {}),
          });
        } catch { /* the next progress tick can retry */ }
      }
    } finally { busy = false; }
  }
  return (event: OcrEvent) => {
    if (terminal) return;
    total = event.total ?? total;
    done = event.done ?? done;
    review = event.reviewPages ?? review;
    const finished = ['complete', 'stopped', 'fatal'].includes(event.type);
    terminal = finished;
    if (!finished && event.type !== 'retry' && last && Date.now() - last < 5000) return;
    // Retry notifications are also throttled; avoid one update per blurry line.
    if (!finished && event.type === 'retry' && last && Date.now() - last < 5000) return;
    last = Date.now();
    let detail = event.type === 'queued' ? '等待 OCR 处理' : event.type === 'preparing' ? '检查文档与已完成页面' :
      event.type === 'retry' ? `第 ${event.page} 页有模糊区域，正在以 300 DPI 重试` : `已处理 **${done} / ${total} 页**${event.page ? ` · 当前第 ${event.page} 页` : ''}`;
    if (event.type === 'complete') detail = `已处理 **${event.processedPages?.length ?? total} 页**。提取文本将交给助手读取。`;
    if (event.type === 'stopped') detail = 'OCR 已暂停。已完成页面已保存，重试原附件任务会从断点继续。';
    if (event.type === 'fatal') detail = 'OCR 未完成。已保存的页面可以在重试原附件任务时复用。';
    if (review.length) detail += `\n\n⚠️ **第 ${formatPageRanges(review).length > 3000 ? `${formatPageRanges(review).slice(0, 3000)}…（其余见复核清单）` : formatPageRanges(review)} 页仍有识别不清或未完成的区域**，请提供更清晰的这些页，或人工核对。完整页码清单也会交给助手。`;
    if (!finished) detail += '\n\n发送 `/stop` 可暂停；同一会话后续问题会等待文档处理。';
    pending = { config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `${finished ? '文档识别' : '正在识别文档'} · ${fileName.slice(0, 100)}` }, template: review.length || event.type === 'fatal' || event.type === 'stopped' ? 'orange' : finished ? 'green' : 'blue' },
      elements: [{ tag: 'markdown', content: detail }] };
    void drain();
  };
}
