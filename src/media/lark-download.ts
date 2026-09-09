import type { LarkTenant } from '../config/env.js';
import { downloadInRanges, type DownloadOptions } from './range-download.js';

/** Fixed vendor origin, short-lived in-memory credentials, no redirect leakage. */
export function createLarkResourceDownloader(input: {
  appId: string; appSecret: string; tenant: LarkTenant;
  fetch?: typeof fetch;
}) {
  const fetcher = input.fetch ?? fetch;
  const origin = input.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  let token: { value: string; expires: number } | undefined;
  let pendingToken: Promise<string> | undefined;
  async function accessToken(): Promise<string> {
    if (token && token.expires > Date.now()) return token.value;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const response = await fetcher(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
      });
      const data = await response.json() as { code?: number; tenant_access_token?: string; expire?: number };
      if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error('Attachment authentication failed');
      token = { value: data.tenant_access_token, expires: Date.now() + Math.max(0, (data.expire ?? 0) - 60) * 1000 };
      return token.value;
    })().finally(() => { pendingToken = undefined; });
    return pendingToken;
  }
  return async (messageId: string, fileKey: string, type: 'file' | 'image', destination: string, options: DownloadOptions = {}) => {
    const url = `${origin}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
    await downloadInRanges(async (range, signal) => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const value = await new Promise<string>((resolve, reject) => {
          const cancel = () => reject(signal.reason);
          signal.addEventListener('abort', cancel, { once: true });
          accessToken().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        });
        signal.throwIfAborted();
        const response = await fetcher(url, { redirect: 'error', signal, headers: { Authorization: `Bearer ${value}`, Range: range } });
        if (response.status !== 401 || attempt > 0) return response;
        await response.body?.cancel();
        if (token?.value === value) token = undefined;
      }
    }, `${origin}/${messageId}/${fileKey}/${type}`, destination, options);
  };
}
