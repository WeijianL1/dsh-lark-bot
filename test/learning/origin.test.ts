import { expect, it } from 'vitest';
import type { DurableQueuedMessage } from '../../src/bot/job-ledger.js';
import { resolveLearningIdentity } from '../../src/learning/origin.js';
it('does not reclassify a Feishu session as local when its correlation is unavailable', () => {
  expect(resolveLearningIdentity({ sessionId: 's', workspace: '/w', rpcId: 'lost', boundToFeishu: true })).toBeUndefined();
  expect(resolveLearningIdentity({ sessionId: 's', workspace: '/w', boundToFeishu: false })).toBeUndefined();
});
it('binds the exact speaker/workspace and refuses bots or mismatched receipts', () => {
  const input = { sessionId: 's', workspace: '/w', rpcId: 'rpc', boundToFeishu: false, origin: { sessionId: 's', workspace: '/w', messageId: 'm' }, message: { senderId: 'alice', workspaceCwd: '/w', chatId: 'chat', chatType: 'group', content: 'Human text\n\n<scoped_feedback_memory>Prior lesson' } as DurableQueuedMessage };
  expect(resolveLearningIdentity(input)).toMatchObject({ actorId: 'alice', chatId: 'chat', originalText: 'Human text', transport: 'feishu' });
  expect(resolveLearningIdentity({ ...input, workspace: '/other' })).toBeUndefined();
  expect(resolveLearningIdentity({ ...input, message: { ...input.message, senderType: 'bot' } })).toBeUndefined();
  expect(resolveLearningIdentity({ sessionId: 'local', workspace: '/w', rpcId: 'local-rpc', boundToFeishu: false })).toMatchObject({ transport: 'local', actorId: 'local-owner' });
});
