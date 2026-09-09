import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('deterministic Python OCR coordinator', () => {
  it('resumes committed pages, rejects corrupt cache, isolates errors and selects quality retries', () => {
    expect(() => execFileSync('python3', ['test/media/python/test_worker.py'], { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow();
  });
});
