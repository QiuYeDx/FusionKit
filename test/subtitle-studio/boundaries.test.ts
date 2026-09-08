import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkBoundaries } from '../../scripts/subtitle-studio/check-boundaries.mjs';
import { isPublicStudioChannel, assertLegacyStudioChannelAllowed } from '../../electron/preload/subtitle-studio-channel-policy';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';

describe('studio boundaries', () => {
  it('allows only fixed public methods', () => {
    expect(isPublicStudioChannel(STUDIO_CHANNELS.register)).toBe(false);
    expect(isPublicStudioChannel(STUDIO_CHANNELS.importSubtitle)).toBe(true);
    expect(isPublicStudioChannel(`${STUDIO_CHANNELS.importSubtitle}-fake`)).toBe(false);
    expect(() => assertLegacyStudioChannelAllowed(STUDIO_CHANNELS.register)).toThrow();
  });
  it('rejects direct, transitive, type, dynamic, helper and resource dependencies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-boundaries-'));
    try {
      await mkdir(path.join(root, 'scripts/subtitle-studio'), { recursive: true });
      const config = JSON.parse(await readFile('scripts/subtitle-studio/boundaries.json', 'utf8'));
      config.roots = ['entry.ts'];
      await writeFile(path.join(root, 'scripts/subtitle-studio/boundaries.json'), JSON.stringify(config));
      const oldRoot = ['electron', 'main', 'translation'].join('/');
      await mkdir(path.join(root, oldRoot), { recursive: true });
      await writeFile(path.join(root, oldRoot, 'old.ts'), 'export const value = 1');
      const specifier = `./${oldRoot}/old`;
      for (const source of [`import '${specifier}'`, `export * from '${specifier}'`, `import type { Value } from '${specifier}'`, `const value = import('${specifier}')`, `type Value = import('${specifier}').Value`]) {
        await writeFile(path.join(root, 'entry.ts'), source);
        expect(checkBoundaries(root).errors.length).toBeGreaterThan(0);
      }
      await writeFile(path.join(root, 'entry.ts'), "import './barrel'");
      await writeFile(path.join(root, 'barrel.ts'), `export * from '${specifier}'`);
      expect(checkBoundaries(root).errors.join(' ')).toContain('barrel.ts');
      await writeFile(path.join(root, 'entry.ts'), `const asset = '${['resources', 'local-subtitle', 'model.bin'].join('/')}'`);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Forbidden runtime string');
      const helper = ['test', 'local-subtitle', 'helper'].join('/');
      await mkdir(path.dirname(path.join(root, helper)), { recursive: true });
      await writeFile(path.join(root, `${helper}.ts`), 'export const fixture = 1');
      await writeFile(path.join(root, 'entry.ts'), `import './${helper}'`);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Forbidden dependency');
      await writeFile(path.join(root, 'entry.ts'), 'export const value = 1');
      expect(checkBoundaries(root).errors).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
