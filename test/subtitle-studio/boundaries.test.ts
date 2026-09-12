import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkBoundaries } from '../../scripts/subtitle-studio/check-boundaries.mjs';
import { isPublicStudioChannel, assertLegacyStudioChannelAllowed } from '../../electron/preload/subtitle-studio-channel-policy';
import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('studio boundaries', () => {
  it('keeps the current repository within audited dependency boundaries', () => {
    expect(checkBoundaries(repositoryRoot).errors).toEqual([]);
  });
  it('restricts a test build dependency to its exact audited source and package', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-scoped-package-'));
    try {
      await mkdir(path.join(root, 'scripts/subtitle-studio'), { recursive: true });
      const config = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
      config.roots = ['entry.ts']; config.scopedPackages = [{ source: 'entry.ts', package: 'esbuild' }];
      const policy = path.join(root, 'scripts/subtitle-studio/boundaries.json');
      await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'entry.ts'), 'import { build } from "esbuild";');
      expect(checkBoundaries(root).errors).toEqual([]);
      await writeFile(path.join(root, 'entry.ts'), 'import "esbuild/internal";');
      expect(checkBoundaries(root).errors.join(' ')).toContain('Unaudited package');
      config.roots = ['other.ts']; await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'other.ts'), 'import { build } from "esbuild";');
      expect(checkBoundaries(root).errors.join(' ')).toContain('Unaudited package');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
      const config = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
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
  it('audits computed native loaders by exact source, expression, hash and count', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-loader-boundary-'));
    try {
      await mkdir(path.join(root, 'scripts/subtitle-studio'), { recursive: true });
      const config = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
      config.roots = ['entry.ts'];
      config.dynamicAudits = [];
      const policy = path.join(root, 'scripts/subtitle-studio/boundaries.json');
      await writeFile(policy, JSON.stringify(config));
      const source = 'import { createRequire } from "node:module"; createRequire(import.meta.url)(addonPath);';
      const expression = 'createRequire(import.meta.url)(addonPath)';
      for (const candidate of [
        source,
        'import { createRequire as makeLoader } from "node:module"; const load = makeLoader(import.meta.url); load(addonPath);',
        'import * as modules from "node:module"; const load = modules.createRequire(import.meta.url); const alias = load; alias(addonPath);',
        'const load = require; load(addonPath);',
        '(require)(addonPath);',
        'let load; load = require; load(addonPath);',
      ]) {
        await writeFile(path.join(root, 'entry.ts'), candidate);
        expect(checkBoundaries(root).errors.join(' ')).toContain('Non-literal dependency');
      }
      for (const candidate of [
        'import { createRequire } from "node:module"; (createRequire(import.meta.url))(addonPath);',
        'import * as modules from "node:module"; const { createRequire } = modules; createRequire(import.meta.url)(addonPath);',
        'import * as modules from "node:module"; modules["createRequire"](import.meta.url)(addonPath);',
        'const modules = await import("node:module"); modules.createRequire(import.meta.url)(addonPath);',
      ]) {
        await writeFile(path.join(root, 'entry.ts'), candidate);
        expect(checkBoundaries(root).errors.join(' ')).toContain('Unaudited module loader factory');
      }
      config.dynamicAudits = [{ source: 'entry.ts', expression, sha256: createHash('sha256').update(source).digest('hex'), count: 1 }];
      await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'entry.ts'), source);
      expect(checkBoundaries(root).errors).toEqual([]);
      await writeFile(path.join(root, 'entry.ts'), `${source} ${expression};`);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Dynamic dependency audit changed');
      await writeFile(path.join(root, 'entry.ts'), source.replace('addonPath', 'otherPath'));
      expect(checkBoundaries(root).errors.join(' ')).toContain('Non-literal dependency');
      config.roots = ['other.ts'];
      await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'other.ts'), source);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Non-literal dependency');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects old resource paths and only exempts immutable historical evidence bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-resource-boundary-'));
    try {
      await mkdir(path.join(root, 'scripts/subtitle-studio'), { recursive: true });
      const config = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
      config.roots = ['evidence.json'];
      config.immutableEvidence = [];
      const policy = path.join(root, 'scripts/subtitle-studio/boundaries.json');
      const evidence = JSON.stringify({ historicalRecipe: ['scripts', 'local-subtitle', 'build.mjs'].join('/') });
      await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'evidence.json'), evidence);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Forbidden resource string');
      config.immutableEvidence = [{ source: 'evidence.json', sha256: createHash('sha256').update(evidence).digest('hex') }];
      await writeFile(policy, JSON.stringify(config));
      expect(checkBoundaries(root).errors).toEqual([]);
      await writeFile(path.join(root, 'evidence.json'), `${evidence}\n`);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Immutable evidence changed');
      await writeFile(path.join(root, 'evidence.json'), 'not json');
      expect(checkBoundaries(root).errors.join(' ')).toContain('Invalid JSON');
      config.roots = ['different.json'];
      await writeFile(policy, JSON.stringify(config));
      await writeFile(path.join(root, 'different.json'), evidence);
      expect(checkBoundaries(root).errors.join(' ')).toContain('Forbidden resource string');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('binds native sources to reviewed bytes and rejects new unaudited native files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-native-boundary-'));
    try {
      await mkdir(path.join(root, 'scripts/subtitle-studio'), { recursive: true });
      await mkdir(path.join(root, 'native/fixture'), { recursive: true });
      const config = JSON.parse(await readFile(path.join(repositoryRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
      const policy = path.join(root, 'scripts/subtitle-studio/boundaries.json');
      config.roots = ['native/fixture/'];
      config.auditedSources = [];
      const source = 'int protocol() { return 4; }\n';
      await writeFile(path.join(root, 'native/fixture/addon.cc'), source);
      await writeFile(policy, JSON.stringify(config));
      expect(checkBoundaries(root).errors.join(' ')).toContain('Unaudited native source');
      config.auditedSources = [{ source: 'native/fixture/addon.cc', sha256: createHash('sha256').update(source).digest('hex') }];
      await writeFile(policy, JSON.stringify(config));
      expect(checkBoundaries(root).errors).toEqual([]);
      await writeFile(path.join(root, 'native/fixture/addon.cc'), source.replace('4', '5'));
      expect(checkBoundaries(root).errors.join(' ')).toContain('Audited source changed');
      await writeFile(path.join(root, 'native/fixture/helper.h'), '#define VERSION 4\n');
      expect(checkBoundaries(root).errors.join(' ')).toContain('Unaudited native source');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
