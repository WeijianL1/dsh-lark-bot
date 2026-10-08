// Native Web bridge probe: isolated home/workspace, local fake model, no Lark credentials.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bin = process.env.DSH_HOST_PROBE_BIN;
if (!bin) throw new Error('Set DSH_HOST_PROBE_BIN to the pinned dsh CLI module');
const root = await mkdtemp(join(tmpdir(), 'dsh-host-probe-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
await Promise.all([mkdir(home), mkdir(workspace)]);
if (process.env.DSH_HOST_PROBE_SESSIONS) await cp(process.env.DSH_HOST_PROBE_SESSIONS, join(home, 'sessions'), { recursive: true });
const expectedSessions = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (/^session\.jsonl(?:\.zstd)?$/.test(entry.name)) {
      const bytes = file.endsWith('.zstd') ? execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }) : await readFile(file);
      const header = JSON.parse(bytes.toString('utf8').split('\n')[0]);
      if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('Unsupported legacy header');
      expectedSessions.push({ sessionId: header.id, hasCwd: typeof header.cwd === 'string', child: header.delegationDepth > 0 });
    }
  }
}
if (process.env.DSH_HOST_PROBE_SESSIONS) await inventory(join(home, 'sessions'));
const adapter = join(root, 'adapter.mjs');
await build({ entryPoints: [resolve('src/adapters/dsh/host-adapter.ts')], outfile: adapter,
  bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24' });
const feedback = join(root, 'feedback.mjs');
const learning = join(root, 'learning.mjs');
await Promise.all([
  build({ entryPoints: [resolve('src/feedback/generate.ts')], outfile: feedback, bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24' }),
  build({ entryPoints: [resolve('src/learning/host.ts')], outfile: learning, bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24' }),
]);
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try { JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      { choices: [{ delta: { role: 'assistant', content: 'Host ' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: { content: 'probe passed' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } },
    ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
const probe = join(root, 'probe.mjs');
await writeFile(probe, `
import { HostDshAdapter } from ${JSON.stringify(pathToFileURL(adapter).href)};
import { feedbackGenerator } from ${JSON.stringify(pathToFileURL(feedback).href)};
import { attachConversationLearning } from ${JSON.stringify(pathToFileURL(learning).href)};
export const name = 'native-host-compat-probe';
export const inject = ['sessionController', 'sessionQuery', 'llm'];
export function apply(ctx) {
  void (async () => {
    const observations = [];
    const stopLearning = attachConversationLearning(ctx, {
      resolve: () => ({ chatId: 'probe-chat', chatType: 'p2p', actorId: 'probe-user', transport: 'feishu', workspace: ${JSON.stringify(workspace)} }),
      observe: async evidence => { observations.push(evidence); }, recall: async () => '', activity: () => {},
    });
    const adapter = new HostDshAdapter(ctx, { provider: 'compat-host', model: 'compat-model' });
    if (${Boolean(process.env.DSH_HOST_PROBE_SESSIONS)}) {
      let listed;
      const expected = ${JSON.stringify(expectedSessions)};
      for (let attempt = 0; ; attempt++) {
        listed = await adapter.rpc('session.list', {});
        const visible = new Set(listed.result.value.items.map(item => item.sessionId));
        const missing = expected.filter(item => item.hasCwd && !visible.has(item.sessionId));
        if (!missing.length) break;
        if (attempt >= 20) throw new Error('Legacy session inventory mismatch: ' + JSON.stringify({ expected: expected.length, visible: visible.size, missing: missing.length }));
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      let pages = 0;
      for (const item of expected) {
        const full = await ctx.sessionQuery.readSession(item.sessionId);
        if (!Array.isArray(full.events)) throw new Error('Complete legacy replay missing');
        if (item.child || !item.hasCwd) continue;
        let beforeSeq;
        for (;;) {
          const history = await adapter.rpc('session.history', { sessionId: item.sessionId, maxMessages: 20, beforeSeq });
          const page = history.result.value;
          if (!Array.isArray(page.events)) throw new Error('Legacy history unreadable');
          pages++;
          if (!page.hasMore) break;
          const seqs = page.events.map(record => record.event?.seq ?? record.seq).filter(Number.isFinite);
          const next = Math.min(...seqs);
          if (!Number.isFinite(next) || (beforeSeq !== undefined && next >= beforeSeq)) throw new Error('Legacy history paging did not advance');
          beforeSeq = next;
        }
      }
      console.log('LEGACY_HOST_HISTORY_PROBE_OK count=' + expected.length + ' pages=' + pages);
    }
    const created = await adapter.rpc('session.create', { cwd: ${JSON.stringify(workspace)} });
    const sessionId = created.result.value.sessionId;
    for (let i = 0; ; i++) {
      try { await ctx.sessionController.selectModel({ sessionId, provider: 'compat-host', model: 'compat-model' }); break; }
      catch (error) { if (i >= 20) throw error; await new Promise(r => setTimeout(r, 250)); }
    }
    for (let i = 0; i < 2; i++) {
      const run = adapter.run({ runId: 'probe-' + i, prompt: 'Verify native host bridge', sessionId, cwd: ${JSON.stringify(workspace)} });
      let text = ''; let usage = 0;
      for await (const event of run.events) {
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'text') text += event.delta;
        if (event.type === 'usage') usage++;
      }
      if (text !== 'Host probe passed' || usage !== 1) throw new Error('Native output or usage mismatch: ' + JSON.stringify({text, usage}));
    }
    const history = await adapter.rpc('session.history', { sessionId, maxMessages: 20 });
    if (!history.result.value.events.some(record => record.event.type === 'assistant/message')) throw new Error('Committed history missing');
    const repaired = await feedbackGenerator(() => ctx.llm)({ system: 'Repair the answer without tools', prompt: 'Synthetic correction', provider: 'compat-host', model: 'compat-model', signal: AbortSignal.timeout(10000) });
    if (repaired !== 'Host probe passed') throw new Error('Tool-free feedback generation failed');
    await stopLearning();
    if (observations.length !== 2 || !observations[1].answer?.includes('Host probe passed')) throw new Error('Conversation learning lost the previous answer or user event');
    await adapter.dispose();
    console.log('NATIVE_HOST_PROBE_OK');
  })().catch(error => console.error('NATIVE_HOST_PROBE_FAILED', error));
}
`);
const patch = join(root, 'patch.yml');
await writeFile(patch, `- id: llm-pi-ai
  config:
    providers:
      compat-host:
        api: openai-completions
        baseURL: ${endpoint}
        apiKeyEnv: COMPAT_HOST_KEY
        models:
          - id: compat-model
- insert:
    - id: native-host-probe
      name: ${JSON.stringify(probe)}
`);
console.log(`[host-probe] isolated home: ${home}`);
const child = spawn(process.execPath, [bin, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: workspace, env: { ...process.env, DSH_HOME: home, COMPAT_HOST_KEY: 'synthetic', DSH_PERMISSION_MODE: 'danger-full-access', DSH_LARK_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host probe timeout: ${output}`)), 120_000);
    const inspect = chunk => {
      output = (output + chunk).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]').slice(-12000);
      if (output.includes('NATIVE_HOST_PROBE_OK')) { clearTimeout(timer); resolve(); }
      if (output.includes('NATIVE_HOST_PROBE_FAILED')) { clearTimeout(timer); reject(new Error(output)); }
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${output}`)); });
  });
  if (process.env.DSH_HOST_PROBE_SESSIONS) console.log('[host-probe] ' + output.match(/LEGACY_HOST_HISTORY_PROBE_OK[^\n]*/)?.[0]);
  console.log('[host-probe] real native create, streaming answer, one usage sample per step, continuation, history, tool-free feedback and conversation learning passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  await new Promise(resolve => model.close(resolve));
}
