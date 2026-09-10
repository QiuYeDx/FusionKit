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
    const reviewCandidates: typeof preview.candidates = [];
    for (let offset = 0; offset < preview.reviewCount; offset += 20) {
      const page = await service.preview(doc.id, 1, options, offset, undefined, true);
      expect(page.offset).toBe(offset);
      expect(page.totalCandidates).toBe(preview.reviewCount);
      reviewCandidates.push(...page.candidates);
    }
    expect(reviewCandidates.length).toBe(preview.reviewCount);
    expect(new Set(reviewCandidates.map(candidate => candidate.id)).size).toBe(preview.reviewCount);
    const applied = await service.apply(doc.id, 1, options);
    const reopened = await new DocumentRepository(root).read(doc.id);
    expect(reopened).toEqual(applied);
    expect(applied.cues).toHaveLength(format === 'lrc' ? 3930 : 3931);
    expect(Object.keys(applied.translationTracks[0].entries)).toHaveLength(3930);
    const appliedCues = new Map(applied.cues.map(cue => [cue.id, cue]));
    for (const candidate of reviewCandidates) {
      const cue = appliedCues.get(candidate.id)!;
      expect(!!cue, `review source at ${candidate.startMs}`).toBe(true);
      expect(candidate.first === cue.source.plain, `preview source agrees at ${candidate.startMs}`).toBe(true);
      expect(candidate.second === applied.translationTracks[0].entries[cue.id].text.plain, `preview target agrees at ${candidate.startMs}`).toBe(true);
    }
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
    let repeatedSources = 0;
    let identicalPairs = 0;
    let crossFormatMatches = 0;
    let repeatedWholePairs = 0;
    let repeatedWholeMatches = 0;
    if (format === 'lrc') {
      // Derive expected text directly from the input lines, independently of bilingual analysis.
      const rawLines = bytes.toString('utf8').replace(/^\ufeff/, '').split(/\r?\n/)
        .map(line => /^\[(\d+:[0-5]\d(?:\.\d{1,3})?)\](.*)$/.exec(line))
        .filter((line): line is RegExpExecArray => line !== null);
      expect(rawLines.length).toBe(doc.cues.length);
      for (const [index, line] of rawLines.entries()) expect(line[2] === doc.cues[index].source.plain, `raw cue ${index + 1}`).toBe(true);
      const counterparts = await readSubtitle(`${process.env.FUSIONKIT_STUDIO_BILINGUAL_INPUT_BASE}.srt`, 'utf-8');
      const entryFor = (id: string) => applied.translationTracks[0].entries[id];
      const versionDifferenceTime = (6 * 3600 + 2 * 60 + 54) * 1000 + 910;
      const changedIds: string[] = [];
      const expectedChangedIds: string[] = [];
      let structuralPairs = 0;
      for (let index = 0; index < rawLines.length - 1; index++) {
        const first = rawLines[index];
        const second = rawLines[index + 1];
        if (first[1] !== second[1] || rawLines[index - 1]?.[1] === first[1] || rawLines[index + 2]?.[1] === first[1]) continue;
        structuralPairs++;
        const originalCue = doc.cues[index];
        const cue = appliedCues.get(originalCue.id)!;
        const prefix = first[2].slice(0, first[2].length - second[2].length);
        const repeated = second[2].length > 0 && first[2] === prefix + second[2] && /\s$/u.test(prefix) && prefix.trimEnd().length > 0;
        const identical = first[2] === second[2];
        // The supplied duplicate mixed rows each have one independently observable kana/Han boundary.
        const boundaries = identical ? [...first[2].matchAll(/\s+/gu)].filter(separator => {
          const before = first[2].slice(0, separator.index);
          const after = first[2].slice(separator.index! + separator[0].length);
          return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(before)
            && /\p{Script=Han}/u.test(after) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(after);
        }) : [];
        const mixedBoundary = boundaries.length === 1 ? boundaries[0] : undefined;
        const expectedSource = mixedBoundary ? first[2].slice(0, mixedBoundary.index) : repeated ? prefix.trimEnd() : first[2];
        const target = mixedBoundary ? first[2].slice(mixedBoundary.index! + mixedBoundary[0].length) : second[2];
        expect(!!cue, `retained source cue ${index + 1}`).toBe(true);
        expect(cue.source.plain === expectedSource, `source body at ${first[1]}`).toBe(true);
        expect(entryFor(cue.id).text.plain === target, `target body at ${first[1]}`).toBe(true);
        expect(appliedCues.has(doc.cues[index + 1].id), `collapsed target cue ${index + 2}`).toBe(false);
        if (cue.source.plain !== first[2]) changedIds.push(cue.id);
        if (identical && !mixedBoundary) {
          identicalPairs++;
          expect(cue.source.plain === entryFor(cue.id).text.plain).toBe(true);
        }
        if (!repeated && !mixedBoundary) continue;
        if (mixedBoundary) repeatedWholePairs++;
        else repeatedSources++;
        expectedChangedIds.push(cue.id);
        expect(first[2] === `${cue.source.plain} ${target}`, `one complete duplicate removed at ${first[1]}`).toBe(true);
        expect(cue.source.plain.endsWith(` ${target}`), `no repeated target suffix at ${first[1]}`).toBe(false);
        expect(cue.importedPair!.source.end - cue.importedPair!.source.start).toBe(expectedSource.length);
        const corresponding = counterparts.cues.filter(item => item.timing.startMs === originalCue.timing.startMs);
        expect(corresponding.length, `unique SRT interval at ${first[1]}`).toBe(1);
        const expectedLines = corresponding[0].source.plain.split('\n');
        expect(expectedLines.length).toBe(2);
        expect(expectedLines[1] === target, `SRT target at ${first[1]}`).toBe(true);
        if (originalCue.timing.startMs === versionDifferenceTime) {
          expect(expectedLines[0] !== expectedSource, 'preserve the differing source version').toBe(true);
        } else {
          expect(expectedLines[0] === cue.source.plain, `SRT source at ${first[1]}`).toBe(true);
          if (mixedBoundary) repeatedWholeMatches++;
          else crossFormatMatches++;
        }
      }
      expect(structuralPairs).toBe(3685);
      expect(changedIds).toEqual(expectedChangedIds);
      expect(repeatedSources).toBe(282);
      expect(identicalPairs).toBe(13);
      expect(crossFormatMatches).toBe(281);
      expect(repeatedWholePairs).toBe(46);
      expect(repeatedWholeMatches).toBe(46);
    }
    expect(sourceBytes(reopened).equals(bytes)).toBe(true);
    const cleared = await service.removeTrack(doc.id, applied.revision, applied.translationTracks[0].id);
    expect(cleared.cues).toEqual(applied.cues);
    expect(cleared.translationTracks).toEqual([]);
    expect(sourceBytes(cleared).equals(bytes)).toBe(true);
    expect((await readFile(input)).equals(bytes)).toBe(true);
    console.log(JSON.stringify({ format, importedCues: doc.cues.length, structuralPairs: ordinary.pairedCount,
      withInlinePairs: preview.pairedCount, review: preview.reviewCount, remaining: preview.remainingCount,
      resultCues: applied.cues.length, repeatedSources, identicalPairs, crossFormatMatches, repeatedWholePairs, repeatedWholeMatches, sourcePreserved: true }));
  }, 30000);
});
