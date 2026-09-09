import type { RunState } from './run-state.js';
import type { CardDensity } from './density.js';
import { localizedCard, type CardLocale } from './i18n.js';
import { progressDetail, progressPlan } from './progress-details.js';

// Keep the complete localized JSON below a conservative transport byte budget,
// including multibyte query/title/plan text and the three localized copies.
const RUN_CARD_JSON_BUDGET = 28_000;
const MAX_VISIBLE_TOOL_CALLS = 8;
const MAX_OWNER_LENGTH = 160;
const MAX_ACTION_SCOPE_LENGTH = 512;
const MAX_ACTION_RUN_ID_LENGTH = 160;
const MAX_FINAL_FALLBACK_LENGTH = 8_000;

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function footerStatus(
  state: RunState,
  now: number,
  locale: CardLocale,
): object {
  const zh = locale === 'zh_cn';
  let text = zh ? '进度会自动更新' : 'Progress updates automatically';
  if (state.lastActivityMs !== undefined) {
    const idle = Math.max(0, Math.round((now - state.lastActivityMs) / 1000));
    if (idle >= 60) text += zh ? ` · ⏸ 无响应 ${idle}s` : ` · ⏸ No activity for ${idle}s`;
  }
  return noteMd(text);
}

function summaryText(state: RunState, locale: CardLocale): string {
  const zh = locale === 'zh_cn';
  if (state.terminal === 'interrupted') return zh ? '已中断' : 'Interrupted';
  if (state.terminal === 'idle_timeout') return zh ? '已超时' : 'Timed out';
  if (state.terminal === 'error') return zh ? '出错' : 'Failed';
  if (state.terminal === 'done') {
    const hasToolWarning = state.blocks.some(
      (block) => block.kind === 'tool' && block.tool.status === 'error',
    );
    if (hasToolWarning) return zh ? '已完成（含警告）' : 'Completed with warnings';
    return zh ? '已完成' : 'Completed';
  }
  if (state.footer === 'tool_running') {
    const active = state.blocks.filter((block) => block.kind === 'tool' && block.tool.status === 'running').at(-1);
    return active?.kind === 'tool' ? activityLabel(active.tool.name, locale) : zh ? '正在处理任务' : 'Working on your request';
  }
  if (state.footer === 'streaming') return zh ? '正在整理回答' : 'Preparing your answer';
  return zh ? '正在分析问题' : 'Considering your request';
}

function fallbackSummaryText(state: RunState, locale: CardLocale): string {
  const zh = locale === 'zh_cn';
  const parts = [summaryText(state, locale)];
  if (state.terminal === 'error') parts.push(zh ? '详情见本机日志' : 'See local logs for details');
  if (state.finalDeliveryError) parts.push(zh ? '最终回答发送失败' : 'Final answer delivery failed');
  return parts.join(' · ').slice(0, 500);
}

function stopButton(
  scope: string | undefined,
  runId: string | undefined,
  locale: CardLocale,
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: locale === 'zh_cn' ? '⏹ 终止' : '⏹ Stop' },
    type: 'danger',
    value: {
      cmd: 'stop',
      ...(scope ? { scope: boundedText(scope, MAX_ACTION_SCOPE_LENGTH) } : {}),
      ...(runId ? { runId: boundedText(runId, MAX_ACTION_RUN_ID_LENGTH) } : {}),
    },
  };
}

/** Curated categories only: never turn tool arguments or model reasoning into UI text. */
function activityLabel(name: string, locale: CardLocale): string {
  const n = name.toLowerCase();
  const labels: [RegExp, string, string][] = [
    [/ocr|recogniz|extract.*(?:pdf|image)/, '正在识别文档内容', 'Recognizing document content'],
    [/search|browse|crawl|fetch|tavily|pkulaw/, '正在查找资料', 'Looking up information'],
    [/mnemon|memory|recall/, '正在查阅已有记录', 'Reviewing saved information'],
    [/read|open.*file|document.*get/, '正在阅读资料', 'Reading material'],
    [/write|edit|patch|create.*(?:file|document)/, '正在编写内容', 'Writing content'],
    [/send|upload|notify/, '正在发送内容', 'Sending content'],
    [/ask_user|approval|request_secret/, '正在等待你的确认', 'Waiting for your input'],
  ];
  const match = labels.find(([pattern]) => pattern.test(n));
  return match ? match[locale === 'zh_cn' ? 1 : 2] : locale === 'zh_cn' ? '正在处理任务' : 'Working on your request';
}


function hasAnswer(state: RunState): boolean {
  return state.blocks.some((block) => block.kind === 'text' && block.content.trim() !== '');
}

function processElements(
  state: RunState,
  locale: CardLocale,
  maxTools: number,
): object[] {
  const zh = locale === 'zh_cn';
  const elements: object[] = [];
  const tools = state.blocks.filter((block) => block.kind === 'tool');
  const plan = progressPlan(tools.map((block) => block.tool), locale);
  if (plan.length) elements.push(markdown(`**${zh ? '计划进度' : 'Plan progress'}**\n${plan.join('\n')}`));
  const details = tools.flatMap((block) => {
    const detail = progressDetail(block.tool, locale);
    return detail ? [detail] : [];
  });
  const visible = maxTools === 0 ? [] : details.slice(-maxTools);
  if (details.length > visible.length) {
    elements.push(noteMd(zh ? `已隐藏 ${details.length - visible.length} 条较早的处理记录` : `${details.length - visible.length} earlier records hidden`));
  }
  for (const detail of visible) {
    elements.push(markdown(`**${detail.title}**\n${detail.lines.join('\n')}`));
  }
  // Routine setup and repeated plan updates are already counted in the metrics row.
  const failed = tools.filter((block) => !progressDetail(block.tool, locale) && block.tool.status === 'error').length;
  if (failed) elements.push(noteMd(zh ? `${failed} 次其他操作未成功。` : `${failed} other operations were unsuccessful.`));
  if (!elements.length) elements.push(noteMd(zh
    ? '暂未收到具体操作说明；有进展时会自动更新。'
    : 'No activity descriptions yet; this updates as work proceeds.'));

  return elements;
}

function thinkingPanel(
  state: RunState,
  locale: CardLocale,
  maxTools: number,
): object {
  return {
    tag: 'collapsible_panel',
    // Secondary progress history stays out of the main reading path.
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: locale === 'zh_cn' ? '查看处理记录' : 'View research activity' },
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '6px' },
    elements: processElements(state, locale, maxTools),
  };
}

function progressSummary(state: RunState, locale: CardLocale): object {
  const icon = state.terminal === 'done' ? '✓' : state.terminal === 'running' ? '◌' : '⚠️';
  return markdown(`**${icon} ${summaryText(state, locale)}**`);
}

function runFailureLine(locale: CardLocale): object {
  return noteMd(locale === 'zh_cn'
    ? '⚠️ Agent 运行失败。可重试；底层详情仅保留在本机日志中。'
    : '⚠️ The agent run failed. Retry it or inspect the local logs for details.');
}

function finalDeliveryFailureLine(locale: CardLocale): object {
  return noteMd(locale === 'zh_cn'
    ? '⚠️ 最终回答发送失败，已尝试在本卡片中显示。'
    : '⚠️ Final-answer delivery failed; the answer is shown in this card when available.');
}

function finalDeliveryFallback(state: RunState, locale: CardLocale): object | undefined {
  if (!state.finalDeliveryError || !state.finalDeliveryFallback) return undefined;
  return markdown(
    `⚠️ **${locale === 'zh_cn' ? '最终回答独立发送失败，已降级显示在此卡片' : 'Final answer delivery failed; showing it in this card'}**\n\n${boundedText(state.finalDeliveryFallback, MAX_FINAL_FALLBACK_LENGTH)}`,
  );
}

function requestMetrics(state: RunState, now: number, locale: CardLocale): object {
  const zh = locale === 'zh_cn';
  const model = state.model ? boundedText(state.model.replace(/[\r\n<>`*\[\]\\]/g, ''), 120) : zh ? '未提供' : 'Not reported';
  const start = state.requestReceivedAtMs ?? state.startedAtMs;
  const end = state.completedAtMs ?? (state.terminal === 'running' ? now : state.lastActivityMs);
  const seconds = start !== undefined && end !== undefined ? Math.max(0, (end - start) / 1000) : undefined;
  const duration = seconds === undefined ? '—' : seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const timing = state.requestReceivedAtMs !== undefined ? zh ? '总耗时' : 'Total time' : zh ? '处理耗时' : 'Processing time';
  const metricTag = (text: string, color: string): string =>
    `<text_tag color='${color}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text_tag>`;
  const parts = [metricTag(`${zh ? '模型' : 'Model'}：${model}`, 'blue'), metricTag(`⏱ ${timing} ${duration}`, 'grey')];
  const tokens = [];
  if (state.usage?.inputTokens !== undefined) tokens.push(`${zh ? '输入' : 'in'} ${state.usage.inputTokens}`);
  if (state.usage?.outputTokens !== undefined) tokens.push(`${zh ? '输出' : 'out'} ${state.usage.outputTokens}`);
  if (tokens.length) parts.push(metricTag(`Tokens · ${tokens.join(' · ')}`, 'purple'));
  const toolCalls = new Set(state.blocks.flatMap((block) => block.kind === 'tool' ? [block.tool.id] : [])).size;
  parts.push(metricTag(zh ? `工具调用 ${toolCalls} 次` : `Tool calls ${toolCalls}`, 'turquoise'));
  return noteMd(parts.join(' '));
}

function ownerLine(state: RunState, locale: CardLocale): object | undefined {
  return state.scopeOwner ? noteMd(`👤 ${locale === 'zh_cn' ? '成员隔离会话' : 'Member-isolated session'}：${boundedText(state.scopeOwner, MAX_OWNER_LENGTH)}`) : undefined;
}

function renderStandard(
  state: RunState,
  now: number,
  locale: CardLocale,
  maxTools: number,
): object {
  const zh = locale === 'zh_cn';
  const elements: object[] = [];
  const owner = ownerLine(state, locale);
  if (owner) elements.push(owner);

  elements.push(progressSummary(state, locale));
  elements.push(thinkingPanel(state, locale, maxTools));

  if (state.terminal === 'interrupted') {
    elements.push(noteMd(zh ? '_⏹ 已被中断_' : '_⏹ Interrupted_'));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(zh ? `_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止_` : `_⏱ No response for ${state.idleTimeoutMinutes ?? 0} minutes; stopped automatically_`));
  } else if (state.terminal === 'error') {
    elements.push(runFailureLine(locale));
  } else if (
    state.terminal === 'done' &&
    !hasAnswer(state)
  ) {
    elements.push(noteMd(zh ? '_（未返回内容）_' : '_(No content returned)_'));
  }
  if (state.finalDeliveryError) {
    elements.push(finalDeliveryFailureLine(locale));
  }
  elements.push({ tag: 'hr' });
  elements.push(requestMetrics(state, now, locale));
  const fallback = finalDeliveryFallback(state, locale);
  if (fallback) elements.push(fallback);

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state, now, locale));
    elements.push(stopButton(state.actionScope, state.actionRunId, locale));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: fallbackSummaryText(state, locale) },
    },
    body: { elements },
  };
}

function renderCompact(
  state: RunState,
  now: number,
  locale: CardLocale,
  maxTools: number,
): object {
  const zh = locale === 'zh_cn';
  const elements: object[] = [];
  const owner = ownerLine(state, locale);
  if (owner) elements.push(owner);
  elements.push(progressSummary(state, locale));
  elements.push(thinkingPanel(state, locale, maxTools));
  if (state.terminal === 'error') {
    elements.push(runFailureLine(locale));
  }
  if (state.finalDeliveryError) {
    elements.push(finalDeliveryFailureLine(locale));
  }
  elements.push({ tag: 'hr' });
  elements.push(requestMetrics(state, now, locale));
  const fallback = finalDeliveryFallback(state, locale);
  if (fallback) elements.push(fallback);
  if (state.terminal === 'done' && !hasAnswer(state)) elements.push(noteMd(zh ? '_（未返回内容）_' : '_(No content returned)_'));
  if (state.terminal === 'running' && state.footer) {
    elements.push(footerStatus(state, now, locale));
  }
  if (state.terminal === 'running') {
    elements.push(stopButton(state.actionScope, state.actionRunId, locale));
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: fallbackSummaryText(state, locale) },
    },
    body: { elements },
  };
}

function renderDetailed(
  state: RunState,
  now: number,
  locale: CardLocale,
  maxTools: number,
): object {
  const zh = locale === 'zh_cn';
  const elements: object[] = [];
  const owner = ownerLine(state, locale);
  if (owner) elements.push(owner);

  elements.push(progressSummary(state, locale));
  elements.push(thinkingPanel(state, locale, maxTools));

  if (state.terminal === 'interrupted') {
    elements.push(noteMd(zh ? '_⏹ 已被中断_' : '_⏹ Interrupted_'));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(zh ? `_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止_` : `_⏱ No response for ${state.idleTimeoutMinutes ?? 0} minutes; stopped automatically_`));
  } else if (state.terminal === 'error') {
    elements.push(runFailureLine(locale));
  } else if (state.terminal === 'done') {
    if (!hasAnswer(state)) elements.push(noteMd(zh ? '_（未返回内容）_' : '_(No content returned)_'));
  }
  if (state.finalDeliveryError) {
    elements.push(finalDeliveryFailureLine(locale));
  }
  elements.push({ tag: 'hr' });
  elements.push(requestMetrics(state, now, locale));
  const fallback = finalDeliveryFallback(state, locale);
  if (fallback) elements.push(fallback);

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state, now, locale));
    elements.push(stopButton(state.actionScope, state.actionRunId, locale));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: fallbackSummaryText(state, locale) },
    },
    body: { elements },
  };
}

/** Render the run card at the requested density (compact / standard / detailed). */
export function renderCard(
  state: RunState,
  density: CardDensity = 'standard',
  now: number = Date.now(),
): object {
  const render = (locale: CardLocale, maxTools: number): object => {
    if (density === 'compact') return renderCompact(state, now, locale, maxTools);
    if (density === 'detailed') return renderDetailed(state, now, locale, maxTools);
    return renderStandard(state, now, locale, maxTools);
  };
  const renderWithToolLimit = (maxTools: number): object =>
    localizeRenderedCard(render('zh_cn', maxTools), render('en_us', maxTools));
  const toolCount = state.blocks.filter((block) => block.kind === 'tool').length;
  return fitToBudget(state, toolCount, renderWithToolLimit, false);
}

/** Plain schema-2.0 card used when the native collapsible component is rejected. */
export function renderLegacyCard(
  state: RunState,
  _density: CardDensity = 'standard',
  now: number = Date.now(),
): object {
  const renderWithToolLimit = (maxTools: number): object => localizeRenderedCard(
    renderLegacyVariant(state, now, 'zh_cn', maxTools),
    renderLegacyVariant(state, now, 'en_us', maxTools),
    true,
  );
  const toolCount = state.blocks.filter((block) => block.kind === 'tool').length;
  return fitToBudget(state, toolCount, renderWithToolLimit, true);
}

function renderLegacyVariant(
  state: RunState,
  now: number,
  locale: CardLocale,
  _maxTools: number,
): object {
  const zh = locale === 'zh_cn';
  const elements: object[] = [];
  const owner = ownerLine(state, locale);
  if (owner) elements.push(owner);
  elements.push(progressSummary(state, locale));
  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state, now, locale));
    elements.push(stopButton(state.actionScope, state.actionRunId, locale));
  } else if (state.terminal === 'interrupted') {
    elements.push(noteMd(zh ? '_⏹ 已被中断_' : '_⏹ Interrupted_'));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(zh ? `_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止_` : `_⏱ No response for ${state.idleTimeoutMinutes ?? 0} minutes; stopped automatically_`));
  } else if (state.terminal === 'error') {
    elements.push(runFailureLine(locale));
  }
  if (state.finalDeliveryError) {
    elements.push(finalDeliveryFailureLine(locale));
  }
  elements.push({ tag: 'hr' });
  elements.push(requestMetrics(state, now, locale));
  const fallback = finalDeliveryFallback(state, locale);
  if (fallback) elements.push(fallback);
  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: fallbackSummaryText(state, locale) },
    },
    body: { elements },
  };
}

function fitToBudget(
  state: RunState,
  toolCount: number,
  renderWithToolLimit: (maxTools: number) => object,
  bilingualFallback: boolean,
): object {
  const initialLimit = Math.min(toolCount, MAX_VISIBLE_TOOL_CALLS);
  const initialCard = renderWithToolLimit(initialLimit);
  if (Buffer.byteLength(JSON.stringify(initialCard), 'utf8') <= RUN_CARD_JSON_BUDGET) return initialCard;

  let low = 0;
  let high = initialLimit - 1;
  let best: object | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderWithToolLimit(middle);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= RUN_CARD_JSON_BUDGET) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? minimalRunCard(state, bilingualFallback);
}

function minimalRunCard(state: RunState, bilingualFallback: boolean): object {
  const variant = (locale: CardLocale): object => ({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state, locale) },
    },
    body: {
      elements: [
        noteMd(locale === 'zh_cn'
          ? '执行记录过长，较早的详情已隐藏。'
          : 'The execution history is too long; older details are hidden.'),
        ...(state.terminal === 'running'
          ? [stopButton(state.actionScope, state.actionRunId, locale)]
          : []),
      ],
    },
  });
  return localizeRenderedCard(variant('zh_cn'), variant('en_us'), bilingualFallback);
}

function localizeRenderedCard(
  zhCard: object,
  enCard: object,
  bilingualFallback = false,
): object {
  const zh = zhCard as { config: Record<string, unknown> & { summary: { content: string } }; body: Record<string, unknown> };
  const en = enCard as { config: Record<string, unknown> & { summary: { content: string } }; body: Record<string, unknown> };
  const { summary: _summary, ...config } = zh.config;
  return localizedCard({
    config,
    bilingualFallback,
    zhCn: { summary: zh.config.summary.content, body: zh.body },
    enUs: { summary: en.config.summary.content, body: en.body },
  });
}
