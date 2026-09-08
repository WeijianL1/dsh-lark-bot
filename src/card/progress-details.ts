import type { ToolEntry } from './run-state.js';
import type { CardLocale } from './i18n.js';
import { redactSecrets } from '../config/security.js';

interface Detail { title: string; lines: string[] }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Display only short, selected metadata; never commands, document bodies or memory content. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean || /password|passwd|secret|credential|authorization|api[_-]?key|access[_-]?token|gh[pousr]_|github_pat_/i.test(clean)) return undefined;
  return redactSecrets(clean).slice(0, 140)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~!])/g, '\\$1');
}

function sourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return text(url.hostname + (url.pathname === '/' ? '' : '/' + decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')));
    } catch { return undefined; }
  }
  const pieces = value.replace(/\\/g, '/').split('/');
  if (pieces.some((part) => part.startsWith('.')) || /(?:secret|credential|token|id_rsa|id_ed25519)/i.test(value)) return undefined;
  return text(pieces.at(-1));
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 256_000) return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Unwrap common JSON/MCP envelopes, without reading free-form result prose. */
function results(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 4) return undefined;
  const parsed = parse(value);
  if (Array.isArray(parsed)) {
    if (parsed.some((item) => record(item)?.type === 'text')) {
      for (const item of parsed.slice(0, 5)) {
        const block = record(item);
        if (block?.type !== 'text') continue;
        const nested = results(block.text, depth + 1);
        if (nested !== undefined) return nested;
      }
      return undefined;
    }
    return parsed;
  }
  const obj = record(parsed);
  if (!obj) return undefined;
  for (const key of ['results', 'items', 'documents', 'hits', 'articles', 'records']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const key of ['structuredContent', 'data', 'result']) {
    const nested = results(obj[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  if (Array.isArray(obj.content)) {
    for (const block of obj.content.slice(0, 5)) {
      const b = record(block);
      if (b?.type !== 'text') continue;
      const nested = results(b.text, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function progressDetail(tool: ToolEntry, locale: CardLocale): Detail | undefined {
  const zh = locale === 'zh_cn';
  const name = tool.name.toLowerCase();
  const input = record(tool.input);
  if (!input || /runtime_memory|remember|forget/.test(name)) return undefined;
  // Execution tools supply a separate, user-facing purpose; never infer it from commands.
  if (/^(bash|exec_command|shell|python)$/.test(name)) {
    const purpose = text(input.description);
    if (!purpose) return undefined;
    const status = tool.status === 'running' ? zh ? '进行中' : 'In progress'
      : tool.status === 'error' ? zh ? '未成功' : 'Unsuccessful' : zh ? '已完成' : 'Completed';
    return { title: `${tool.status === 'error' ? '⚠️' : tool.status === 'done' ? '✓' : '◌'} ${zh ? '操作' : 'Activity'} · ${status}`, lines: [purpose] };
  }
  const search = /search|recall/.test(name);
  const read = !search && /read|fetch|browse|extract|ocr|document.*get/.test(name);
  if (!search && !read) return undefined;
  const subject = search
    ? text(input.query ?? input.search_query ?? input.keyword ?? input.keywords)
    : sourceName(input.path ?? input.file_path ?? input.filePath ?? input.url ?? input.filename);
  const lines: string[] = [];
  if (subject) lines.push(`${zh ? search ? '检索' : '资料' : search ? 'Search' : 'Source'}：${subject}`);
  if (tool.status === 'done') {
    const entries = results(tool.output);
    if (entries !== undefined) {
      lines.push(zh ? `返回 ${entries.length} 条记录` : `Returned ${entries.length} records`);
      const titles = entries.slice(0, 3).flatMap((entry) => {
        const item = record(entry);
        const title = text(item?.title ?? item?.name ?? item?.document_title) ?? sourceName(item?.url ?? item?.file_path);
        return title ? [title] : [];
      });
      for (const title of titles) lines.push(`• ${title}`);
    }
  }
  if (lines.length === 0) return undefined;
  const status = tool.status === 'running' ? zh ? '进行中' : 'In progress'
    : tool.status === 'error' ? zh ? '未成功' : 'Unsuccessful' : zh ? '已完成' : 'Completed';
  const activity = search ? zh ? '查找资料' : 'Information search' : zh ? '阅读资料' : 'Reading material';
  return { title: `${tool.status === 'error' ? '⚠️' : tool.status === 'done' ? '✓' : '◌'} ${activity} · ${status}`, lines };
}

/** Show the newest agent-authored plan once, rather than every todo update. */
export function progressPlan(tools: readonly ToolEntry[], locale: CardLocale): string[] {
  const latest = tools.filter((tool) => tool.name === 'todo_write' && tool.status === 'done').at(-1);
  const todos = record(latest?.input)?.todos;
  if (!Array.isArray(todos)) return [];
  const zh = locale === 'zh_cn';
  return todos.slice(0, 8).flatMap((value) => {
    const item = record(value);
    const content = text(item?.content);
    if (!content || !['pending', 'in_progress', 'completed'].includes(String(item?.status))) return [];
    const status = item?.status === 'completed' ? zh ? '已完成' : 'Completed'
      : item?.status === 'in_progress' ? zh ? '进行中' : 'In progress' : zh ? '待处理' : 'Pending';
    const icon = item?.status === 'completed' ? '✓' : item?.status === 'in_progress' ? '◌' : '○';
    return [`${icon} ${content} · ${status}`];
  });
}
