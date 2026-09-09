import { describe, expect, it } from 'vitest';
import { progressDetail, progressPlan } from '../../src/card/progress-details.js';
import type { ToolEntry } from '../../src/card/run-state.js';

const search = (extra: Partial<ToolEntry> = {}): ToolEntry => ({ id: '1', name: 'pkulaw_search', input: { query: '合同解除' }, status: 'done', ...extra });
describe('progress source metadata', () => {
  it('shows the real search topic and returned titles, not document content or invented conclusions', () => {
    const output = JSON.stringify({ data: { results: [{ title: '民法典', content: 'PRIVATE_BODY' }, { title: '司法解释', snippet: 'PRIVATE_SNIPPET' }] } });
    const detail = progressDetail(search({ output }), 'zh_cn');
    expect(detail?.lines).toEqual(['检索：合同解除', '返回 2 条记录', '• 民法典', '• 司法解释']);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE');
  });
  it('unwraps MCP text envelopes and distinguishes a confirmed empty result from unknown output', () => {
    const output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] });
    expect(progressDetail(search({ output }), 'zh_cn')?.lines).toContain('返回 0 条记录');
    expect(progressDetail(search({ output: 'Cannot parse result' }), 'zh_cn')?.lines).not.toContain('返回 0 条记录');
    expect(progressDetail(search({ output: JSON.stringify([{ type: 'text', text: 'opaque' }]) }), 'zh_cn')?.lines).toEqual(['检索：合同解除']);
  });
  it('shows a document basename or URL source without private directories, query credentials or raw output', () => {
    const file = search({ name: 'read', input: { path: '/workspace/client/report.pdf' }, output: 'PRIVATE_DOCUMENT' });
    expect(progressDetail(file, 'zh_cn')?.lines).toEqual(['资料：report.pdf']);
    expect(progressDetail({ ...file, input: { url: 'https://user:password@example.com/docs/report?token=private#secret' } }, 'en_us')?.lines).toEqual(['Source：example.com/report']);
    expect(progressDetail({ ...file, input: { path: '/home/owner/.config/credentials.json' } }, 'zh_cn')).toBeUndefined();
  });
  it('omits execution payloads, memory writes and underlying failures; escapes display metadata', () => {
    expect(progressDetail(search({ name: 'exec_command', input: { cmd: 'PRIVATE_COMMAND' } }), 'zh_cn')).toBeUndefined();
    expect(progressDetail(search({ name: 'mnemon_runtime_memory', input: { content: 'PRIVATE_MEMORY' } }), 'zh_cn')).toBeUndefined();
    const detail = progressDetail(search({ status: 'error', input: { query: '<at id=all>hello</at>' }, output: 'PRIVATE_ERROR' }), 'zh_cn');
    expect(detail?.title).toContain('未成功');
    expect(JSON.stringify(detail)).not.toContain('<at');
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_ERROR');
    expect(progressDetail(search({ input: { query: 'api_key=PRIVATE_SECRET' } }), 'zh_cn')).toBeUndefined();
  });
});

describe('execution purposes and plan progress', () => {
  it('shows the supplied description but never the command or its output', () => {
    const tool = search({ name: 'bash', input: { description: '查看近期更新记录', command: 'PRIVATE_COMMAND' }, output: 'PRIVATE_OUTPUT' });
    const detail = progressDetail(tool, 'zh_cn');
    expect(detail?.lines).toEqual(['查看近期更新记录']);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE');
    expect(progressDetail({ ...tool, input: { command: 'PRIVATE_COMMAND' } }, 'zh_cn')).toBeUndefined();
  });
  it('shows only the latest successful todo snapshot with statuses, and ignores failed updates', () => {
    const plan = (id: string, status: ToolEntry['status'], content: string, itemStatus: string): ToolEntry =>
      ({ id, name: 'todo_write', status, input: { todos: [{ content, status: itemStatus }] } });
    const tools = [plan('1', 'done', '查看更新', 'in_progress'), plan('2', 'done', '总结新增功能', 'completed'), plan('3', 'error', 'UNSAVED_PLAN', 'pending')];
    expect(progressPlan(tools, 'zh_cn')).toEqual(['✓ 总结新增功能 · 已完成']);
  });
});
