import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { withFileLock } from '../platform/file-lock.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface FeedbackTask {
  id: string;
  kind: 'repair' | 'memory';
  state: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  recordId?: string;
  actorId?: string;
  reasonDigest?: string;
  sourceKeys?: string[];
  chatId: string;
  workspace: string;
  day?: string;
  conversationBatch?: boolean;
  conversationVersion?: string;
  transport?: 'feishu' | 'local';
  evidence?: Array<{ key: string; recordId: string; reason: string; answer?: string; source?: 'conversation'; createdAt?: number }>;
  deliveryStartedAt?: string;
  resultMessageId?: string;
  resultFeedbackId?: string;
  resultFeedbackMessageId?: string;
  report?: string;
  receipts?: Array<{ key: string; result: unknown }>;
}

/** Private outbox and audit trail, separate from card callback record locks. */
export class FeedbackTasks {
  constructor(readonly directory: string) {}
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid task id');
    return join(this.directory, `${id}.json`);
  }
  async list(): Promise<FeedbackTask[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    const tasks: FeedbackTask[] = [];
    for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
      const task = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as FeedbackTask;
      if (`${task.id}.json` !== name) throw new Error('Invalid task record');
      tasks.push(task);
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async enqueue(input: Omit<FeedbackTask, 'state' | 'createdAt' | 'updatedAt'>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withFileLock(this.path(input.id) + '.lock', 'Feedback task busy', async () => {
      try { await readFile(this.path(input.id)); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const now = new Date().toISOString();
      await this.save({ ...input, state: 'pending', createdAt: now, updatedAt: now });
    });
  }
  async save(task: FeedbackTask): Promise<void> {
    task.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.path(task.id), JSON.stringify(task), { mode: 0o600 });
  }
}
