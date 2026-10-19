import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const checker = resolve('scripts/check-host-module-identity.mjs');

async function fixture(run: (root: string, check: () => string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-module-identity-'));
  try {
    for (const pkg of ['host/node_modules/@deepseek-ai/dsh-app-boot', 'profile/node_modules/@deepseek-ai/dsh-app-boot', 'profile/node_modules/@deepseek-ai/dsh-config-editor']) {
      const path = join(root, pkg);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: pkg.split('/').at(-1), version: '0.2.0-rc.2', main: 'index.js' }));
      await writeFile(join(path, 'index.js'), 'module.exports = {};\n');
    }
    await run(root, () => execFileSync(process.execPath, [checker, '--host-bin', join(root, 'host/bin.js'), '--profile', join(root, 'profile')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('Host bootstrap module identity', () => {
  it('rejects separate copies even with identical versions and contents', async () => {
    await fixture(async (_root, check) => { expect(check).toThrow('separate DSH bootstrap module'); });
  });

  it('accepts the profile link to the booted module', async () => {
    await fixture(async (root, check) => {
      const module = join(root, 'profile/node_modules/@deepseek-ai/dsh-app-boot');
      await rm(module, { recursive: true });
      await symlink(join(root, 'host/node_modules/@deepseek-ai/dsh-app-boot'), module, 'dir');
      expect(check()).toContain('share one DSH bootstrap module');
    });
  });

  it('also rejects a private bootstrap copy under the config editor', async () => {
    await fixture(async (root, check) => {
      const module = join(root, 'profile/node_modules/@deepseek-ai/dsh-app-boot');
      const nested = join(root, 'profile/node_modules/@deepseek-ai/dsh-config-editor/node_modules/@deepseek-ai');
      await mkdir(nested, { recursive: true });
      await symlink(module, join(nested, 'dsh-app-boot'), 'dir');
      await rm(module, { recursive: true });
      await symlink(join(root, 'host/node_modules/@deepseek-ai/dsh-app-boot'), module, 'dir');
      // Replace the nested link with a separate, same-version module.
      await rm(join(nested, 'dsh-app-boot'));
      await mkdir(join(nested, 'dsh-app-boot'));
      await writeFile(join(nested, 'dsh-app-boot/package.json'), '{"main":"index.js"}');
      await writeFile(join(nested, 'dsh-app-boot/index.js'), 'module.exports = {};\n');
      expect(check).toThrow('config-editor uses a separate');
    });
  });
});
