import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { attachmentDownloadError } from '../../src/media/download-error.js';

describe('attachmentDownloadError', () => {
  it.each([
    { code: 234037 },
    '{"code":234037}',
    Buffer.from('{"code":234037}'),
    Readable.from(['{"code":', '234037}']),
  ])('recognizes the Feishu limit without retaining HTTP secrets (%#)', async (data) => {
    const error = await attachmentDownloadError({ response: { data }, config: { secret: 'private' } }, 'msg');
    expect(error.sizeExceeded).toBe(true);
    expect(error.messageId).toBe('msg');
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it.each([null, 'not json', { code: 999 }, ' '.repeat(8193)])('uses a generic failure for other bodies (%#)', async (data) => {
    expect((await attachmentDownloadError({ response: { data } }, 'msg')).sizeExceeded).toBe(false);
  });

  it('stops consuming oversized streaming errors', async () => {
    const stream = Readable.from([' '.repeat(8193), '{"code":234037}']);
    expect((await attachmentDownloadError({ response: { data: stream } }, 'msg')).sizeExceeded).toBe(false);
    expect(stream.destroyed).toBe(true);
  });

  it('bounds stalled response streams', async () => {
    const stream = new Readable({ read() {} });
    expect((await attachmentDownloadError({ response: { data: stream } }, 'msg')).sizeExceeded).toBe(false);
    expect(stream.destroyed).toBe(true);
  });
});
