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
  const startedAt = Date.now();
  let cached = 0;
  let retryPages = new Set<number>();
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
    cached = event.cached ?? cached;
    if (event.type === 'retry' && event.page) retryPages.add(event.page);
    if (event.type === 'complete') { total = event.processedPages?.length ?? total; done = total; }
    const finished = ['complete', 'stopped', 'fatal'].includes(event.type);
    terminal = finished;
    if (!finished && event.type !== 'retry' && event.type !== 'started' && last && Date.now() - last < 5000) return;
    // Retry notifications are also throttled; avoid one update per blurry line.
    if (!finished && event.type === 'retry' && last && Date.now() - last < 5000) return;
    last = Date.now();
    const percent = total ? Math.min(100, Math.floor(done / total * 100)) : 0;
    const filled = total ? Math.floor(percent / 100 * 20) : 0;
    const bar = `<font color='blue'>${'▰'.repeat(filled)}</font><font color='grey'>${'▱'.repeat(20 - filled)}</font>`;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    const status = event.type === 'complete' ? (review.length ? '已完成 · 部分页面待复核' : '识别完成') :
      event.type === 'stopped' ? '已暂停 · 断点已保存' : event.type === 'fatal' ? '未完成 · 可从断点重试' :
      event.type === 'queued' ? '排队中' : event.type === 'preparing' ? '正在检查文档' :
      event.type === 'retry' ? `精读第 ${event.page} 页的模糊区域` : '正在逐页识别';
    const color = review.length || event.type === 'stopped' || event.type === 'fatal' ? 'orange' : finished ? 'green' : 'blue';
    const metric = (text: string, tint = 'blue') => `<text_tag color='${tint}'>${text}</text_tag>`;
    const elements: object[] = [
      { tag: 'markdown', content: `${metric(status, color)}\n\n**${total ? `${percent}%` : '准备中'}**  ${total ? `·  ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} 页` : '·  完成检查后显示总页数'}\n${bar}` },
      { tag: 'markdown', content: `${metric(`用时 ${elapsed}`, 'grey')} ${metric(`断点复用 ${cached} 页`, 'grey')} ${metric(`待复核 ${review.length} 页`, review.length ? 'orange' : 'grey')}` },
      { tag: 'hr' },
    ];
    let detail = event.type === 'retry' ? `正在以 **300 DPI** 重试模糊区域，保留更清晰的识别结果。` :
      event.type === 'complete' ? '页码文本与复核清单已生成，接下来由助手阅读。' :
      event.type === 'stopped' ? '已完成页面已保存。重试相同文件和页码范围，即可从断点继续。' :
      event.type === 'fatal' ? '已保存页面可以复用。检查文件和 OCR 环境后，重试相同任务。' :
      event.page ? `当前处理原文件 **第 ${event.page} 页**，逐页保存识别结果。` : '自动提取文字；扫描页会先压缩，再进行识别。';
    if (retryPages.size) detail += `\n已对 ${retryPages.size} 页尝试高清重读。`;
    if (review.length) {
      const ranges = formatPageRanges(review);
      detail += `\n\n⚠️ **第 ${ranges.length > 1800 ? `${ranges.slice(0, 1800)}…（完整页码见复核清单）` : ranges} 页需要复核**\n这些页仍有识别不清或未完成的区域，请提供更清晰的页面或人工核对。`;
    }
    elements.push({ tag: 'markdown', content: detail });
    if (!finished) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '发送 /stop 可暂停 · 完成页面自动保存 · 识别进度不代表内容已核实' }] });
    pending = { config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `文档阅读 · ${fileName.slice(0, 100)}` }, template: color }, elements };
    void drain();
  };
}
