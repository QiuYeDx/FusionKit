import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createWindowsAddonCopyPlan, applyWindowsAddonCopyPlan, WINDOWS_ADDON_RECIPE } from '../../scripts/subtitle-studio-provenance/windows-addon-copy.mjs';

const root = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'resources/subtitle-studio/provenance/transcription-baseline.json'), 'utf8'));
const options = { root, baseline };
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); });

describe('T07 independent Windows addon tooling provenance', () => {
  it('reconstructs six Windows scripts from the fixed source and verifies frozen C++ dependencies', () => {
    const plan = createWindowsAddonCopyPlan(options);
    expect(plan.provenance.sourceCommit).toBe('3a0f50ed15c1b63451402cecf27240182235e567');
    expect(plan.files).toHaveLength(6);
    expect(plan.provenance.dependencies.some(entry => entry.destinationPath === 'native/subtitle-studio-overwrite/src/addon-win32.cc'
      && entry.provenancePath.endsWith('transcription-native-fork.json'))).toBe(true);
    expect(plan.files.every(entry => !entry.destinationPath.startsWith('native/'))).toBe(true);
    expect(plan.provenance.compatibility).toEqual({ napiVersion: 8, nativeProtocolVersion: 4, journalVersion: 3 });
    for (const entry of plan.provenance.files) expect(hash(fs.readFileSync(path.join(root, entry.destinationPath)))).toBe(entry.destinationSha256);
    expect(() => applyWindowsAddonCopyPlan(plan, { root })).not.toThrow();
  }, 60000);
  it('records the exact recovery-host environment repair and its reason', () => {
    const plan = createWindowsAddonCopyPlan(options);
    const recovery = plan.files.find(entry => entry.destinationPath.endsWith('run-addon-windows-recovery-integration.mjs'))!;
    expect(recovery.sourceBytes.toString()).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(recovery.bytes.toString()).toContain('hostEnvironment.ELECTRON_RUN_AS_NODE === "1"');
    expect(recovery.transforms.some(edit => edit.reason.includes('original minimal environment discarded ELECTRON_RUN_AS_NODE'))).toBe(true);
    expect(recovery.transforms.some(edit => edit.reason.includes('exclude NODE_OPTIONS'))).toBe(true);
  }, 60000);
  it.each(['native/subtitle-studio-overwrite/src/addon-win32.cc', 'scripts/subtitle-studio/transcription/overwrite-native/build-addon-macos-arm64.mjs'])
    ('cannot claim ownership of frozen %s', destinationPath => {
      const recipe = structuredClone(WINDOWS_ADDON_RECIPE); recipe.files[0].destinationPath = destinationPath;
      expect(() => createWindowsAddonCopyPlan({ ...options, recipe })).toThrow(/only the six new Windows/);
    });
  it('rejects stale exact transforms, undeclared dependencies and unused C++ edits', () => {
    const recipe = structuredClone(WINDOWS_ADDON_RECIPE); recipe.literalEdits[0].count++;
    expect(() => createWindowsAddonCopyPlan({ ...options, recipe })).toThrow(/literal count differs/);
    expect(() => createWindowsAddonCopyPlan({ ...options, recipe: { ...WINDOWS_ADDON_RECIPE, dependencies: [] } })).toThrow(/Missing native dependency/);
    expect(() => createWindowsAddonCopyPlan({ ...options, recipe: { ...WINDOWS_ADDON_RECIPE, literalEdits: [...WINDOWS_ADDON_RECIPE.literalEdits,
      { sourcePath: 'native/local-subtitle-overwrite/src/addon-win32.cc', fromText: '4', toText: '5', count: 1, reason: 'Forbidden native mutation' }] } })).toThrow(/Unused native copy audit/);
  }, 60000);
  it('rejects a different source commit and modified source digest', () => {
    expect(() => createWindowsAddonCopyPlan({ ...options, recipe: { ...WINDOWS_ADDON_RECIPE, sourceCommit: '0'.repeat(40) } })).toThrow(/source commit differs/);
    const changed = structuredClone(baseline);
    changed.files.find(file => file.sourcePath === WINDOWS_ADDON_RECIPE.files[0].sourcePath).sha256 = '0'.repeat(64);
    expect(() => createWindowsAddonCopyPlan({ root, baseline: changed })).toThrow(/source content differs/);
  }, 60000);
  it('preflights destination conflict and never overwrites user bytes or publishes partial provenance', () => {
    const plan = createWindowsAddonCopyPlan(options);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-windows-copy-')); temporary.push(directory);
    const destination = path.join(directory, plan.files[0].destinationPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'user destination');
    expect(() => applyWindowsAddonCopyPlan(plan, { root: directory, write: true })).toThrow(/Destination content differs/);
    expect(fs.readFileSync(destination, 'utf8')).toBe('user destination');
    expect(fs.existsSync(path.join(directory, 'resources/subtitle-studio/provenance/transcription-windows-addon-fork.json'))).toBe(false);
  }, 60000);
});
