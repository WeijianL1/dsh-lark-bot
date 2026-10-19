// Profile reload state belongs to the booted module instance, not its version.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--host-bin' || args[2] !== '--profile') {
  throw new Error('Usage: node scripts/check-host-module-identity.mjs --host-bin <dsh/lib/bin.js> --profile <directory>');
}
const host = createRequire(resolve(args[1]));
const profile = createRequire(join(resolve(args[3]), 'package.json'));
const bootstrap = '@deepseek-ai/dsh-app-boot';
const canonical = realpathSync(host.resolve(bootstrap));
const editor = profile.resolve('@deepseek-ai/dsh-config-editor');
for (const [label, importer] of [['profile', profile], ['config-editor', createRequire(editor)]]) {
  const selected = realpathSync(importer.resolve(bootstrap));
  if (selected !== canonical) {
    throw new Error(`${label} uses a separate DSH bootstrap module; profile reload cannot share the root Include state. Link ${bootstrap} to the host installation before activating this profile.`);
  }
}
console.log('Host and profile configuration editor share one DSH bootstrap module.');
