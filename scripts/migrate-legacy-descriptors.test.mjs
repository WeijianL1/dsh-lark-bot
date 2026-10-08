import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMnemonSummary } from './migrate-legacy-descriptors.mjs';

test('Mnemon conversion retains message semantics and archives original source without mutation', () => {
  for (const form of ['instructions', 'recall']) {
    const event = { seq: 1, type: 'user/message', data: { role: 'system', content: [{ type: 'text', text: '完整指令\u2028继续' }], source: { kind: 'plugin', plugin: 'dsh-mnemon', form, summary: '旧摘要' } } };
    const converted = normalizeMnemonSummary(event);
    assert.equal(converted.seq, event.seq);
    assert.equal(converted.data.content, event.data.content);
    assert.equal(converted.data.role, event.data.role);
    assert.equal(converted.data.source.form, form);
    assert.equal(converted.data.source.summary, undefined);
    assert.equal(event.data.source.summary, '旧摘要');
    for (const source of [{ ...event.data.source, plugin: 'other' }, { ...event.data.source, form: 'notice' }]) {
      const unchanged = { ...event, data: { ...event.data, source } };
      assert.equal(normalizeMnemonSummary(unchanged), unchanged);
    }
    const malformed = { ...event, data: { ...event.data, source: { ...event.data.source, summary: 42 } } };
    assert.throws(() => normalizeMnemonSummary(malformed), /Unsupported/);
  }
});
