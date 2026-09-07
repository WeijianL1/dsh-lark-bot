import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from '../platform/file-lock.js';
import { writeFileAtomic } from '../platform/atomic-write.js';

export interface FeedbackVote {
  actorId: string;
  actorName?: string;
  rating: 'up' | 'down';
  updatedAt: string;
  reason?: string;
  reasonShared?: boolean;
  token?: string;
  promptMessageId?: string;
  repairTaskId?: string;
}
export interface FeedbackRecord {
  version: 1;
  id: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId?: string;
  feedbackMessageId?: string;
  kind: 'text' | 'file' | 'image';
  text?: string;
  fileName?: string;
  origin?: { question?: string; workspace: string; threadId?: string };
  createdAt: string;
  votes: FeedbackVote[];
}

/** One private file per delivered item; mutations are atomic across processes. */
export class FeedbackStore {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Invalid feedback id');
    }
    return join(this.directory, `${id}.json`);
  }

  async create(input: Pick<FeedbackRecord, 'chatId' | 'chatType' | 'kind' | 'text' | 'fileName' | 'origin'>): Promise<FeedbackRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const record: FeedbackRecord = { ...input, version: 1, id: randomUUID(), createdAt: new Date().toISOString(), votes: [] };
    await writeFileAtomic(this.path(record.id), JSON.stringify(record), { mode: 0o600 });
    return record;
  }

  async list(): Promise<FeedbackRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);
    const records: FeedbackRecord[] = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) records.push(await this.read(name.slice(0, -5)));
    return records;
  }

  async read(id: string): Promise<FeedbackRecord> {
    const data = JSON.parse(await readFile(this.path(id), 'utf8')) as FeedbackRecord;
    if (data.version !== 1 || data.id !== id || !Array.isArray(data.votes)) throw new Error('Invalid feedback record');
    return data;
  }

  async mutate<T>(id: string, update: (record: FeedbackRecord) => T | Promise<T>): Promise<T> {
    const file = this.path(id);
    return withFileLock(`${file}.lock`, 'Feedback is busy; retry', async () => {
      const record = await this.read(id);
      const result = await update(record);
      await writeFileAtomic(file, JSON.stringify(record), { mode: 0o600 });
      return result;
    });
  }
}
