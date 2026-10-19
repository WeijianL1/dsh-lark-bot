import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshProviderManager } from '../../src/config/dsh-config.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'lark-native-models-'));
  roots.push(home);
  const settingsFile = join(home, 'settings.yaml');
  const modelCatalog = vi.fn().mockResolvedValue({
    default: { provider: 'openai-codex', model: 'gpt-6-sol' },
    routableProviders: ['openai-codex'],
    groups: [{ id: 'openai-codex', name: 'Codex OAuth', models: [
      { id: 'gpt-6-sol', name: 'GPT Sol', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      { id: 'gpt-6-astra', name: 'GPT Astra' },
    ] }],
    failures: [{ id: 'offline-provider', name: 'Offline', message: 'Unavailable' }],
  });
  const saveDefault = vi.fn().mockResolvedValue(undefined);
  const legacyCatalog = { listProviders: vi.fn().mockRejectedValue(new Error('Must not use models.dev')) };
  const manager = new DshProviderManager({ home, env: {}, settingsFile,
    runtime: { modelCatalog, saveDefault }, catalog: legacyCatalog });
  return { manager, modelCatalog, saveDefault, legacyCatalog, settingsFile };
}

describe('native Host model configuration', () => {
  it('lists OAuth models with no legacy settings or public catalog lookup', async () => {
    const { manager, legacyCatalog, settingsFile } = await fixture();
    const providers = await manager.listProviders();
    expect(providers).toHaveLength(2);
    expect(providers[1]).toMatchObject({ id: 'offline-provider', models: [], catalogUnavailable: true });
    expect(providers[0]).toMatchObject({ id: 'openai-codex', displayName: 'Codex OAuth', managed: false });
    expect(providers[0]?.models.map((model) => model.id)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    expect(providers[0]?.models[0]?.reasoningEfforts).toEqual(['high']);
    expect(await manager.resolveModelRoute('openai-codex/gpt-6-astra')).toEqual({ provider: 'openai-codex', model: 'gpt-6-astra' });
    expect(await manager.resolveModelRoute('gpt-6-astra')).toEqual({ provider: 'openai-codex', model: 'gpt-6-astra' });
    expect(legacyCatalog.listProviders).not.toHaveBeenCalled();
    await expect(readFile(settingsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads the current Host default and saves through the owning service', async () => {
    const { manager, saveDefault, settingsFile } = await fixture();
    await writeFile(settingsFile, 'not valid legacy settings: [');
    expect(await manager.defaultModelSelection()).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' });
    await manager.setDefaultModel('gpt-6-astra');
    expect(saveDefault).toHaveBeenCalledWith({ provider: 'openai-codex', model: 'gpt-6-astra' });
    expect(await readFile(settingsFile, 'utf8')).toBe('not valid legacy settings: [');
  });

  it('rejects unknown routes without saving a default', async () => {
    const { manager, saveDefault } = await fixture();
    await expect(manager.setDefaultModel('openai-codex/missing')).rejects.toThrow('未在任何已配置');
    expect(saveDefault).not.toHaveBeenCalled();
  });

  it('surfaces Host catalog failure without inventing a legacy fallback', async () => {
    const { manager, modelCatalog } = await fixture();
    modelCatalog.mockRejectedValue(new Error('Host catalog unavailable'));
    await expect(manager.listProviders()).rejects.toThrow('Host catalog unavailable');
  });

  it('requires provider qualification for ambiguous native model IDs', async () => {
    const { manager, modelCatalog } = await fixture();
    const catalog = await modelCatalog();
    catalog.groups.push({ id: 'other', name: 'Other', models: [{ id: 'gpt-6-sol', name: 'Other Sol' }] });
    expect(await manager.resolveModelRoute('gpt-6-sol')).toBeUndefined();
    expect(await manager.resolveModelRoute('other/gpt-6-sol')).toEqual({ provider: 'other', model: 'gpt-6-sol' });
  });
});
