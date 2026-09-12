import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('checks out every frozen or audited Studio text path as LF under core.autocrlf', () => {
  const provenanceRoot = 'resources/subtitle-studio/provenance';
  const targets = new Set<string>();
  for (const name of fs.readdirSync(path.join(projectRoot, provenanceRoot))) {
    if (!name.endsWith('.json')) continue;
    const relative = `${provenanceRoot}/${name}`;
    targets.add(relative);
    const provenance = JSON.parse(fs.readFileSync(path.join(projectRoot, relative), 'utf8'));
    for (const file of provenance.files) if (file.destinationPath) targets.add(file.destinationPath);
  }
  const boundaries = JSON.parse(fs.readFileSync(path.join(projectRoot, 'scripts/subtitle-studio/boundaries.json'), 'utf8'));
  for (const audit of [...boundaries.auditedSources, ...boundaries.dynamicAudits, ...boundaries.immutableEvidence]) targets.add(audit.source);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-checkout-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], {
    timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const write = (name: string, bytes: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
  };
  git('init', '-q');
  write('.gitattributes', fs.readFileSync(path.join(projectRoot, '.gitattributes')));
  const canonical = 'first line\nsecond line\n';
  for (const target of targets) write(target, canonical);
  // A text file outside the hash contract retains the host checkout policy.
  const unrelated = 'src/unrelated-checkout-fixture.ts';
  write(unrelated, canonical);
  // Native/model binaries in the same resource folders must remain byte-exact.
  const binary = 'resources/subtitle-studio/transcription/manifests/fixture.bin';
  const binaryBytes = Buffer.from([0, 13, 10, 128, 10, 255]);
  write(binary, binaryBytes);
  git('add', '.');
  for (const target of [...targets, unrelated, binary]) fs.unlinkSync(path.join(root, target));
  git('checkout-index', '--all', '--force');

  for (const target of targets) expect(fs.readFileSync(path.join(root, target), 'utf8'), target).toBe(canonical);
  expect(fs.readFileSync(path.join(root, unrelated), 'utf8')).toBe(canonical.replaceAll('\n', '\r\n'));
  expect(fs.readFileSync(path.join(root, binary))).toEqual(binaryBytes);
});
