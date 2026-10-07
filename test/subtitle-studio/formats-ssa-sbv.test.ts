import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import type { SubtitleDocument, TextSubtitleDocument } from '../../src/subtitle-studio/domain';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { SSA_HEADER } from '../../src/subtitle-studio/formats/ass';
import { applyBilingual } from '../../src/subtitle-studio/bilingual';
import { projectTranslationUnits, validateTranslationResponse } from '../../src/subtitle-studio/translation-protocol';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { sourceBytes } from '../../electron/main/subtitle-studio/export-service';
import { readSubtitle } from '../../electron/main/subtitle-studio/input-service';

type Format = TextSubtitleDocument['origin']['format'];
const digest = (text: unknown) => createHash('sha256').update(typeof text === 'string' ? text : JSON.stringify(text)).digest('hex');
const parse = (raw: string, format: Format) => importSubtitleText(raw, { format, displayName: `synthetic.${format}`, encoding: 'utf-8', digest: digest(raw) }, randomUUID);
const options = (format: Format, overrides: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format, order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'next-start', finalDurationMs: 1000 }, ...overrides });
function translate(doc: SubtitleDocument) {
  const units = projectTranslationUnits(doc);
  const decoded = validateTranslationResponse(JSON.stringify({ items: units.map(unit => ({ id: unit.id, text: unit.text.replace(/Hello|Again/g, '译文') })) }), units, 1024 * 1024);
  const id = randomUUID();
  doc.translationTracks.push({ id, revision: 1, language: 'zh', origin: 'ai', entries: Object.fromEntries(doc.cues.filter(cue => decoded.has(cue.id)).map(cue => [cue.id,
    { sourceRevision: cue.sourceRevision, sourceHash: digest(cue.source), text: decoded.get(cue.id)!, origin: 'ai', reviewStatus: 'unreviewed' }])) });
  return id;
}
function back(doc: SubtitleDocument, config: ExportOptions) {
  const plan = planSubtitleExport(doc, config);
  expect(plan.issues.filter(issue => issue.blocking)).toEqual([]);
  const raw = iconv.decode(plan.bytes!, config.encoding);
  return { plan, raw, doc: parse(raw, config.format) };
}

const ssa = SSA_HEADER.replace('Style: Default,Arial,48,16777215,255,0,0,0,0,', 'Style: Default,Arial,48,16777215,255,0,0,0,-1,')
  + 'Comment: Marked=0,0:00:00.00,0:00:01.00,Default,,0,0,0,,note\n'
  + 'Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\\Nworld\n'
  + 'Dialogue: Marked=0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\b1}Again{\\b0}\n';
const sbv = '0:00:01.000,0:00:02.500\nHello\nworld\n\n0:00:03.000,0:00:04.000\nAgain\n';

describe('SSA and SBV studio formats', () => {
  it('imports SSA v4.00 with inherited style marks and preserves the script on source export', () => {
    const doc = parse(ssa, 'ssa');
    expect(doc.cues.map(cue => [cue.timing, cue.source.plain])).toEqual([
      [{ startMs: 1000, endMs: 2000, provenance: 'ssa' }, 'Hello\nworld'],
      [{ startMs: 3000, endMs: 4000, provenance: 'ssa' }, 'Again'],
    ]);
    expect(doc.cues[0].source.spans[0].marks).toEqual(['i']);
    expect(doc.cues[1].source.spans[0].marks).toEqual(['i', 'b']);
    expect(doc.capabilities.translate).toBe(true);
    expect(sourceBytes(doc).toString()).toBe(ssa);
    expect(() => parse(ssa.replace('v4.00', 'v3.00'), 'ssa')).toThrow('unsupported_feature');
  });

  it('patches SSA dialogue in place when exporting a translation and rebuilds SSA from other formats', () => {
    const doc = parse(ssa, 'ssa');
    const trackId = translate(doc);
    const target = back(doc, options('ssa', { mode: 'target', trackId }));
    expect(target.raw).toContain('ScriptType: v4.00\n');
    expect(target.raw).toContain('Comment: Marked=0,0:00:00.00,0:00:01.00,Default,,0,0,0,,note\n');
    expect(target.doc.cues.map(cue => cue.source.plain)).toEqual(['译文\nworld', '译文']);
    const rebuilt = back(parse('1\n00:00:01,005 --> 00:00:02,000\n<i>Hello</i>\n', 'srt'), options('ssa'));
    expect(rebuilt.raw.startsWith(SSA_HEADER)).toBe(true);
    expect(rebuilt.raw).toContain('Dialogue: Marked=0,0:00:01.01,0:00:02.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\n');
    expect(rebuilt.plan.issues).toContainEqual(expect.objectContaining({ code: 'timing_precision_changed' }));
    expect(planSubtitleExport(doc, options('ass', { encoding: 'gb18030' })).issues).toContainEqual(expect.objectContaining({ code: 'encoding_not_supported', blocking: true }));
  });

  it('imports SBV blocks and keeps the original bytes', () => {
    const doc = parse(sbv, 'sbv');
    expect(doc.cues.map(cue => [cue.timing, cue.source.plain])).toEqual([
      [{ startMs: 1000, endMs: 2500, provenance: 'sbv' }, 'Hello\nworld'],
      [{ startMs: 3000, endMs: 4000, provenance: 'sbv' }, 'Again'],
    ]);
    expect(sourceBytes(doc).toString()).toBe(sbv);
    expect(parse('1:02:03.004,1:02:05.000\nlate\n', 'sbv').cues[0].timing.startMs).toBe(3723004);
    for (const raw of ['0:00:02.000,0:00:01.000\nx', '00:00:01,000 --> 00:00:02,000\nx', '0:00:01.000\nx']) expect(() => parse(raw, 'sbv')).toThrow('invalid_input');
  });

  it('exports SBV as plain text, estimating LRC end times and reporting dropped styles', () => {
    const fromLrc = back(parse('[00:03.00]Again\n[00:01.00]Hello\n', 'lrc'), options('sbv'));
    expect(fromLrc.raw).toBe('0:00:03.000,0:00:04.000\nAgain\n\n0:00:01.000,0:00:03.000\nHello\n\n');
    expect(fromLrc.plan.issues).toContainEqual(expect.objectContaining({ code: 'estimated_end', count: 2 }));
    const styled = back(parse(ssa, 'ssa'), options('sbv'));
    expect(styled.raw).toContain('0:00:01.000,0:00:02.000\nHello\nworld\n');
    expect(styled.plan.issues).toContainEqual(expect.objectContaining({ code: 'styles_removed' }));
    const doc = parse(sbv, 'sbv');
    const trackId = translate(doc);
    expect(back(doc, options('sbv', { mode: 'bilingual', trackId })).raw).toBe('0:00:01.000,0:00:02.500\nHello\nworld\n译文\nworld\n\n0:00:03.000,0:00:04.000\nAgain\n译文\n\n');
  });

  it('separates two-line SBV bilingual cues into a source and an imported track', () => {
    const doc = parse('0:00:01.000,0:00:02.000\nおはようございます\n早上好\n\n0:00:03.000,0:00:04.000\nありがとう\n谢谢\n', 'sbv');
    const separated = applyBilingual(doc, { sourceSide: 'first', splitInline: false, overrides: [] }, randomUUID, cue => digest(cue.source));
    expect(separated.cues.map(cue => cue.source.plain)).toEqual(['おはようございます', 'ありがとう']);
    const trackId = separated.translationTracks[0].id;
    expect(back(separated, options('sbv', { mode: 'target', trackId })).raw).toBe('0:00:01.000,0:00:02.000\n早上好\n\n0:00:03.000,0:00:04.000\n谢谢\n\n');
  });

  it('reads .ssa and .sbv files from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-formats-'));
    try {
      await writeFile(path.join(dir, 'a.ssa'), ssa);
      await writeFile(path.join(dir, 'b.sbv'), sbv);
      expect((await readSubtitle(path.join(dir, 'a.ssa'), 'utf-8')).origin.format).toBe('ssa');
      expect((await readSubtitle(path.join(dir, 'b.sbv'), 'utf-8')).cues).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
