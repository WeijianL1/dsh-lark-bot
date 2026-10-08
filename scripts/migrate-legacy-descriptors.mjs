// Offline upgrade preparation. Originals remain untouched; only a new copy is normalized.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdtemp, realpath, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function normalizeDescriptor(event, oldFold, newFold) {
  if (event.type !== 'subagent/descriptor' || event.data?.version !== 2) return event;
  const before = oldFold([event]);
  if (!before || JSON.stringify(before) !== JSON.stringify(event.data)) {
    // Object property order is not significant; compare sorted JSON below.
    if (!before || stable(before) !== stable(event.data)) throw new Error('Descriptor is not exactly the supported v2 shape');
  }
  const candidate = { ...event, data: { ...event.data, version: 3 } };
  const after = newFold([candidate]);
  if (!after || stable(after) !== stable({ ...before, version: 3 })) throw new Error('Descriptor normalization changed its composition');
  return candidate;
}

export function normalizeMnemonSummary(event) {
  const source = event.type === 'user/message' ? event.data?.source : undefined;
  if (source?.kind !== 'plugin' || source.plugin !== 'dsh-mnemon' ||
      !['instructions', 'recall'].includes(source.form) || source.summary === undefined) return event;
  if (typeof source.summary !== 'string') throw new Error('Unsupported Mnemon summary shape');
  const { summary, ...compatibleSource } = source;
  return { ...event, data: { ...event.data, source: compatibleSource } };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function files(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Session tree contains a symlink');
    if (entry.isDirectory()) found.push(...await files(file));
    else if (entry.isFile() && /session\.jsonl(?:\.zstd)?$/.test(entry.name)) found.push(file);
  }
  return found;
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, 'old-module': { type: 'string' }, 'new-module': { type: 'string' }, 'mnemon-summary-policy': { type: 'string' } } });
  for (const key of ['input', 'output', 'old-module', 'new-module']) if (!values[key]) throw new Error(`Missing --${key}`);
  if (values['mnemon-summary-policy'] && values['mnemon-summary-policy'] !== 'archive') throw new Error('Unsupported Mnemon summary policy');
  const input = await realpath(resolve(values.input));
  const parent = await realpath(dirname(resolve(values.output)));
  const output = join(parent, basename(resolve(values.output)));
  const overlaps = (from, to) => { const path = relative(from, to); return path === '' || (!isAbsolute(path) && path.split(/[\\/]/)[0] !== '..'); };
  if (overlaps(input, output) || overlaps(output, input)) throw new Error('Output and original session trees must not overlap');
  try { await lstat(output); throw new Error('Output already exists; use a fresh destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const oldFold = (await import(pathToFileURL(resolve(values['old-module'])).href)).foldSubagentDescriptor;
  const newFold = (await import(pathToFileURL(resolve(values['new-module'])).href)).foldSubagentDescriptor;
  if (!oldFold || !newFold) throw new Error('Both pinned runtimes must export descriptor validators');
  const staging = await mkdtemp(join(parent, '.dsh-session-upgrade-'));
  await cp(input, staging, { recursive: true });
  const patches = [];
  const sources = [];
  for (const file of await files(staging)) {
    const compressed = file.endsWith('.zstd');
    const original = await readFile(file);
    const path = relative(staging, file);
    sources.push({ path, digest: digest(original) });
    const text = compressed ? execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8') : original.toString('utf8');
    let count = 0;
    const mnemonSummaries = [];
    const lines = text.split('\n').map(line => {
      if (!line) return line;
      const event = JSON.parse(line);
      let normalized = normalizeDescriptor(event, oldFold, newFold);
      const compatible = normalizeMnemonSummary(normalized);
      if (compatible !== normalized) {
        if (values['mnemon-summary-policy'] !== 'archive') throw new Error('Mnemon summary conversion requires explicit --mnemon-summary-policy archive');
        mnemonSummaries.push({ seq: event.seq, source: event.data.source });
        normalized = compatible;
      }
      if (normalized === event) return line;
      if (event.type === 'subagent/descriptor') count++;
      return JSON.stringify(normalized);
    });
    if (count || mnemonSummaries.length) {
      const plain = Buffer.from(lines.join('\n'));
      // DSH requires the first Zstandard frame to contain only the header.
      // Body batches are independently checksummed frames, never one combined
      // header+body frame (which the native index correctly rejects).
      const encode = input => execFileSync('zstd', ['-q', '-c', '--check'], { input, maxBuffer: 256 * 1024 * 1024 });
      const headerEnd = plain.indexOf(10) + 1;
      if (compressed && headerEnd < 1) throw new Error('Compressed session header is not terminated');
      const bytes = compressed ? Buffer.concat([encode(plain.subarray(0, headerEnd)), encode(plain.subarray(headerEnd))]) : plain;
      patches.push({ path, descriptors: count, mnemonSummaries, before: digest(original), after: digest(bytes), bytes });
    }
  }
  // Fail if the live source changed during copying/scanning. Activation must
  // still use a quiesced snapshot, not a concurrently written production tree.
  const currentPaths = (await files(input)).map(file => relative(input, file)).sort();
  if (stable(currentPaths) !== stable(sources.map(source => source.path).sort())) throw new Error('Source inventory changed while preparing the snapshot');
  for (const source of sources) {
    if (digest(await readFile(join(input, source.path))) !== source.digest) throw new Error('Source changed while preparing the snapshot; retry after stopping the writer');
  }
  for (const patch of patches) {
    const destination = join(staging, patch.path);
    if (digest(await readFile(destination)) !== patch.before) throw new Error('Prepared copy changed before normalization');
    const temporary = `${destination}.upgrade-prepared`;
    await writeFile(temporary, patch.bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  }
  const receipt = { schemaVersion: 1, operation: 'legacy-history-compatibility', mnemonSummaryPolicy: values['mnemon-summary-policy'] ?? 'reject', createdAt: new Date().toISOString(),
    input, output, sourceFiles: sources, files: patches.map(({ bytes, ...patch }) => patch) };
  await writeFile(`${output}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(staging, output);
  console.log(`Prepared ${patches.length} session copies; normalized ${patches.reduce((sum, patch) => sum + patch.descriptors, 0)} descriptors and ${patches.reduce((sum, patch) => sum + patch.mnemonSummaries.length, 0)} Mnemon summaries; originals unchanged.`);
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
