import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { withFileLock } from '../platform/file-lock.js';
import { digest } from '../feedback/tasks.js';
import type { MemoryReceipt } from '../feedback/memory.js';

export interface LearningIdentity {
  chatId: string; chatType: 'p2p' | 'group'; actorId: string; workspace: string;
  transport: 'feishu' | 'local';
}
export interface ConversationEvidence extends LearningIdentity {
  key: string; recordId: string; sessionId: string; messageId: string;
  reason: string; answer?: string; createdAt: number;
}
export interface LearnedLesson {
  key: string; text: string; sources: string[]; createdAt: number;
  receipt: MemoryReceipt; supersededBy?: string; pendingSupersededBy?: string;
  revisions?: Array<{ receipt: MemoryReceipt; sources: string[]; createdAt: number }>;
}
export class LearningJournal {
  constructor(readonly directory: string) {}
  async observe(input: Omit<ConversationEvidence, 'key' | 'recordId'>): Promise<void> {
    const key = digest(`conversation:${input.sessionId}:${input.messageId}`);
    const dir = join(this.directory, 'conversations');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${key}.json`);
    await withFileLock(path + '.lock', 'Conversation receipt busy', async () => {
      try { await readFile(path); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await writeFileAtomic(path, JSON.stringify({ ...input, key, recordId: key }), { mode: 0o600 });
    });
  }
  async list(): Promise<ConversationEvidence[]> {
    const dir = join(this.directory, 'conversations');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const result: ConversationEvidence[] = [];
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const item = JSON.parse(await readFile(join(dir, name), 'utf8')) as ConversationEvidence;
      if (name !== `${item.key}.json`) throw new Error('Invalid conversation receipt');
      result.push(item);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }
  async lessons(scope: string): Promise<LearnedLesson[]> {
    try { const data = JSON.parse(await readFile(join(this.directory, 'lessons', `${digest(scope)}.json`), 'utf8')); return Array.isArray(data) ? data : data.lessons; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  async scopes(): Promise<string[]> {
    const dir = join(this.directory, 'lessons'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const scopes: string[] = [];
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (typeof data.scope === 'string' && `${digest(data.scope)}.json` === name) scopes.push(data.scope);
    }
    return scopes;
  }
  /** Called under the shared feedback worker lock. Native receipts precede this audit commit. */
  async saveLessons(scope: string, lessons: LearnedLesson[]): Promise<void> {
    const dir = join(this.directory, 'lessons'); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, `${digest(scope)}.json`), JSON.stringify({ scope, lessons }), { mode: 0o600 });
  }
}
