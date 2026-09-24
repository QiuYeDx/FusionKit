import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { skillArchiveBase64 } from '../../electron/main/translation-knowledge/skill-archive.generated';
import { parseKnowledgePackage } from '../../src/translation-knowledge/validation';
import { resolveEnvironment } from '../../src/translation-knowledge/execution';
import { sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

export function readSkillZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', entry => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { zip.close(); reject(error); return; }
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

describe('downloadable material-authoring skill', () => {
  it('produces the same distributable from LF and CRLF checkouts', async () => {
    const { buildSkillArchive, skillDirectory, skillFiles } = await import('../../scripts/translation-knowledge/skill-archive.mjs');
    const crlf = new Map<string, string>();
    for (const file of skillFiles) {
      const relative = `${skillDirectory}/${file}`;
      crlf.set(relative, (await readFile(relative, 'utf8')).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    }
    expect(await buildSkillArchive(process.cwd(), crlf)).toEqual(Buffer.from(skillArchiveBase64, 'base64'));
  });

  it('contains exactly the portable skill and every file matches the project source', async () => {
    const files = await readSkillZip(Buffer.from(skillArchiveBase64, 'base64'));
    expect(files.size).toBe(12);
    for (const [name, bytes] of files) {
      expect(name.startsWith('fusionkit-translation-knowledge/')).toBe(true);
      expect(name.split('/')).not.toContain('..');
      expect(bytes.toString('utf8')).toBe((await readFile(path.join('.agents/skills', name), 'utf8')).replace(/\r\n/g, '\n'));
      if (name.endsWith('.md')) {
        for (const [, target] of bytes.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
          if (!target.startsWith('https:')) expect(files.has(path.posix.normalize(path.posix.join(path.posix.dirname(name), target)))).toBe(true);
        }
      }
    }
  });

  it('validates all distributed examples using the extracted CLI without project dependencies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fusionkit-skill-'));
    try {
      const files = await readSkillZip(Buffer.from(skillArchiveBase64, 'base64'));
      for (const [name, bytes] of files) {
        const destination = path.join(root, name);
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
      }
      const skillRoot = path.join(root, 'fusionkit-translation-knowledge');
      for (const [name, bytes] of files) if (name.endsWith('.fktk.json')) {
        const current = parseKnowledgePackage(bytes.toString('utf8'));
        expect(current.valid).toBe(true);
        const report = JSON.parse(execFileSync(process.execPath, [path.join(skillRoot, 'scripts/validate.mjs'), path.join(root, name), '--json'], { cwd: root, encoding: 'utf8' }));
        expect(report.valid).toBe(true);
        expect(report.stats).toEqual(current.stats);
      }
      const bad = path.join(root, 'bad.fktk.json'); await writeFile(bad, '{"format":"wrong"}');
      expect(() => execFileSync(process.execPath, [path.join(skillRoot, 'scripts/validate.mjs'), bad, '--json'], { cwd: root, stdio: 'pipe' })).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('the starter becomes usable after adoption and matches Japanese without hidden object requirements', async () => {
    const bytes = await readFile('.agents/skills/fusionkit-translation-knowledge/examples/ja-starter.fktk.json', 'utf8');
    const data = parseKnowledgePackage(bytes).data!;
    const library: LibrarySnapshot = { data, generation: 1, approvals: {}, imports: [] };
    const selection = { version: 1 as const, languagePair: { source: 'ja', target: 'zh-Hans' }, recipeId: data.recipes[0].id, collectionIds: [], bindings: [], confirmations: [], disabledEntryIds: [] };
    const cues = [{ id: 'test', text: '綿棒を使います。', sourceLanguage: 'ja' }];
    expect(resolveEnvironment(library, selection, cues).items).toHaveLength(0);
    for (const entry of data.entries) {
      entry.state = 'ready'; library.approvals[entry.id] = { revision: entry.revision, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-09-25T00:00:00Z' };
    }
    const result = resolveEnvironment(library, selection, cues);
    expect(result.items).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(result.items.find(e => e.kind === 'term')?.matches[0].target).toBe('棉签');
  });
});
