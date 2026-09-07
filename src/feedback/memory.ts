import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './tasks.js';

const exec = promisify(execFile);
export interface MemoryReceipt { key: string; result: unknown }
export interface FeedbackMemory {
  recall(scope: string, excludedKeys?: string[]): Promise<string>;
  remember(scope: string, key: string, content: string): Promise<MemoryReceipt>;
  forget?(scope: string, receipt: MemoryReceipt): Promise<void>;
}

/** Explicit isolated stores; never changes Mnemon's active/default store. */
export class MnemonFeedbackMemory implements FeedbackMemory {
  constructor(private readonly dataDir: string, private readonly cli = 'mnemon') {}
  private store(scope: string): string { return `lark-feedback-${digest(scope).slice(0, 24)}`; }
  private async run(args: string[], timeout = 30_000): Promise<unknown> {
    const result = await exec(this.cli, ['--data-dir', this.dataDir, ...args], {
      timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (args[0] === 'store') return result.stdout;
    return JSON.parse(result.stdout);
  }
  async recall(scope: string, excludedKeys?: string[]): Promise<string> {
    const stores = await this.run(['store', 'list'], 1000);
    if (!String(stores).split('\n').some((line) => line.replace(/^\*?\s*/, '').trim() === this.store(scope))) return '';
    const result = await this.run(['--store', this.store(scope), '--readonly', 'recall', '--basic', '--limit', '8', 'feedback-provenance:'], 1500);
    if (!Array.isArray(result)) throw new Error('Unexpected memory recall receipt');
    return result.filter((item) => typeof item.content === 'string' && !(excludedKeys ?? []).some(key => item.content.includes(`feedback-provenance:${key}`))).map((item) => item.content).join('\n').slice(0, 4000);
  }
  async forget(scope: string, receipt: MemoryReceipt): Promise<void> {
    const result = receipt.result as { id?: unknown; store?: unknown };
    if (result?.store !== this.store(scope) || typeof result.id !== 'string' || !result.id) throw new Error('Memory retirement scope mismatch');
    try { await this.run(['--store', this.store(scope), 'forget', result.id]); }
    catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      // Native forget is a soft delete but reports a nonzero exit for an already retired id.
      if (failure.code === 1 && typeof failure.stderr === 'string' && failure.stderr.includes(`forget: insight ${result.id} not found or already deleted`)) return;
      throw error;
    }
  }
  async remember(scope: string, key: string, content: string): Promise<MemoryReceipt> {
    const store = this.store(scope);
    const stores = await this.run(['store', 'list']);
    if (!String(stores).split('\n').some((line) => line.replace(/^\*?\s*/, '').trim() === store)) await this.run(['store', 'create', store]);
    const marker = `feedback-provenance:${key}`;
    const existing = await this.run(['--store', store, '--readonly', 'recall', '--basic', '--limit', '10', marker]);
    if (!Array.isArray(existing)) throw new Error('Unexpected memory recall receipt');
    const found = existing.find((item) => typeof item.id === 'string' && typeof item.content === 'string' && item.content.includes(marker));
    if (found) return { key, result: { action: 'existing', id: found.id, store } };
    const result = await this.run(['--store', store, 'remember', '--source', 'agent', '--cat', 'insight', '--tags', 'lark-feedback,screened', '--', `${content}\n[${marker}]`]);
    if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string') throw new Error('Memory write has no durable receipt');
    return { key, result: { ...result, store } };
  }
}
