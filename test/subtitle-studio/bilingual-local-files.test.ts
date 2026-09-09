import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { BilingualService } from '../../electron/main/subtitle-studio/bilingual-service';
import { sourceBytes } from '../../electron/main/subtitle-studio/export-service';
import { sourceDigest } from '../../electron/main/subtitle-studio/translation-planner';

describe.runIf(!!process.env.FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE)('authorized local bilingual files without network', () => {
  const roots: string[] = [];
  afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
  it.each(['lrc', 'srt'] as const)('interprets the supplied %s while retaining original bytes and evidence', async format => {
    const input = `${process.env.FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE}.${format}`;
    const bytes = await readFile(input);
    const doc = await readSubtitle(input, 'utf-8');
    const root = await mkdtemp(path.join(tmpdir(), 'studio-bilingual-local-')); roots.push(root);
    const repository = new DocumentRepository(root);
    await repository.create(doc);
    const service = new BilingualService(repository);
    const options = { sourceSide: 'first' as const, splitInline: false, overrides: [] };
    const ordinary = await service.preview(doc.id, 1, options, 0);
    expect(ordinary.recommended).toBe(true);
    expect(ordinary).toMatchObject(format === 'lrc'
      ? { originalCueCount: 7615, pairedCount: 3685, remainingCount: 245, cueCount: 3930 }
      : { originalCueCount: 3931, pairedCount: 3930, remainingCount: 1, cueCount: 3931 });
    options.splitInline = true;
    const preview = await service.preview(doc.id, 1, options, 0);
    const applied = await service.apply(doc.id, 1, options);
    const reopened = await new DocumentRepository(root).read(doc.id);
    expect(reopened).toEqual(applied);
    expect(applied.cues).toHaveLength(format === 'lrc' ? 3930 : 3931);
    expect(Object.keys(applied.translationTracks[0].entries)).toHaveLength(3930);
    const originalCues = new Map(doc.cues.map(cue => [cue.id, cue]));
    for (const cue of applied.cues) {
      expect(cue.timing).toEqual(originalCues.get(cue.id)!.timing);
      if (cue.importedPair) {
        expect(applied.translationTracks[0].entries[cue.id]).toMatchObject({ origin: 'imported', reviewStatus: 'unreviewed', sourceHash: sourceDigest(cue) });
        const pair = cue.importedPair;
        expect(doc.preservation.rawText.slice(pair.source.start, pair.source.end)).toBe(cue.source.plain);
        expect(doc.preservation.rawText.slice(pair.target.start, pair.target.end)).toBe(applied.translationTracks[0].entries[cue.id].text.plain);
      }
    }
    expect(sourceBytes(reopened).equals(bytes)).toBe(true);
    const cleared = await service.removeTrack(doc.id, applied.revision, applied.translationTracks[0].id);
    expect(cleared.cues).toEqual(applied.cues);
    expect(cleared.translationTracks).toEqual([]);
    expect(sourceBytes(cleared).equals(bytes)).toBe(true);
    expect((await readFile(input)).equals(bytes)).toBe(true);
    console.log(JSON.stringify({ format, importedCues: doc.cues.length, structuralPairs: ordinary.pairedCount,
      withInlinePairs: preview.pairedCount, review: preview.reviewCount, remaining: preview.remainingCount,
      resultCues: applied.cues.length, sourcePreserved: true }));
  }, 30000);
});
