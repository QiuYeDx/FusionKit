import { createHash, randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { LIMITS, type SubtitleCue, type SubtitleDocument, type SubtitleText } from '../../src/subtitle-studio/domain';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { applyBilingual } from '../../src/subtitle-studio/bilingual';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';

const parse = (text: string, format: 'srt' | 'lrc' | 'vtt' | 'ass' = 'lrc') => importSubtitleText(text, { format, displayName: `synthetic.${format}`, encoding: 'utf-8', digest: 'a'.repeat(64) }, randomUUID);
const options = (changes: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format: 'lrc', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'block' }, ...changes });
const digest = (cue: SubtitleCue) => createHash('sha256').update(JSON.stringify(cue.source)).digest('hex');
const plain = (text: string): SubtitleText => ({ plain: text, spans: text ? [{ text, marks: [] }] : [] });
function translated(doc: SubtitleDocument) {
  const id = randomUUID();
  doc.translationTracks.push({ id, revision: 1, language: 'zh', origin: 'ai', entries: Object.fromEntries(doc.cues.map((cue, index) => [cue.id, { sourceRevision: cue.sourceRevision, sourceHash: digest(cue), text: plain(`译文${index + 1}`), origin: 'ai', reviewStatus: 'unreviewed' }])) });
  return id;
}
function back(doc: SubtitleDocument, config: ExportOptions) {
  const plan = planSubtitleExport(doc, config);
  expect(plan.bytes).not.toBeNull();
  const text = iconv.decode(plan.bytes!, config.encoding);
  return { plan, text, doc: parse(text, config.format) };
}

describe('local subtitle export projection', () => {
  it('writes target and both bilingual orders as one SRT block or two equal LRC tags without modifying the document', () => {
    const doc = parse('9\r\n00:00:01,125 --> 00:00:02,500\r\nHello\r\nworld\r\n\r\n23\r\n00:00:01,125 --> 00:00:03,000\r\nAgain\r\n', 'srt');
    const trackId = translated(doc); const before = structuredClone(doc);
    for (const mode of ['source', 'target', 'bilingual'] as const) for (const format of ['srt', 'lrc'] as const) for (const order of ['source-first', 'target-first'] as const) {
      const result = back(doc, options({ mode, format, order, trackId }));
      expect(result.plan).toMatchObject({ revision: 1, sourceCueCount: 2, cueCount: 2, partial: false, missingCount: 0, staleCount: 0 });
      expect(result.doc.cues).toHaveLength(mode === 'bilingual' && format === 'lrc' ? 4 : 2);
      expect(result.doc.cues.map(cue => cue.timing.startMs)).toEqual(Array(mode === 'bilingual' && format === 'lrc' ? 4 : 2).fill(1125));
      const source = format === 'lrc' ? 'Hello world' : 'Hello\nworld';
      const target = '译文1';
      const first = mode === 'source' ? source : mode === 'target' ? target : order === 'source-first' ? source : target;
      expect(result.doc.cues[0].source.plain).toBe(mode === 'bilingual' && format === 'srt' ? [first, order === 'source-first' ? target : source].join('\n') : first);
      if (format === 'srt') expect(result.doc.cues.map(cue => cue.timing.endMs)).toEqual([2500, 3000]);
    }
    expect(doc).toEqual(before);
  });

  it.each(['srt', 'lrc'] as const)('separates original from %s source after bilingual import and track removal', format => {
    const raw = format === 'srt' ? '4\n00:00:01,000 --> 00:00:03,000\nおはよう\n早上好\n' : '[00:01]おはよう\n[00:01]早上好\n';
    const doc = applyBilingual(parse(raw, format), { sourceSide: 'first', splitInline: false, overrides: [] }, randomUUID, digest);
    const trackId = doc.translationTracks[0].id;
    expect(back(doc, options({ format, mode: 'target', trackId })).doc.cues[0].source.plain).toBe('早上好');
    doc.translationTracks = [];
    const before = structuredClone(doc);
    expect(back(doc, options({ format })).doc.cues[0].source.plain).toBe('おはよう');
    expect(back(doc, options({ format })).text).not.toContain('早上好');
    expect(planSubtitleExport(doc, options({ format })).issues.some(issue => issue.code === 'metadata_omitted')).toBe(false);
    for (const mode of ['target', 'bilingual'] as const) for (const incomplete of ['block', 'skip', 'source-fallback'] as const) {
      const plan = planSubtitleExport(doc, options({ format, mode, trackId, incomplete }));
      expect(plan.bytes).toBeNull(); expect(plan.issues).toContainEqual({ code: 'track_missing', count: 1, blocking: true, confirmation: false });
    }
    expect(doc.preservation.rawText).toBe(raw); expect(doc).toEqual(before);
  });

  it('requires complete current translations, then skips or falls back once with an explicit partial record', () => {
    const doc = parse('[00:01]one\n[00:02]two\n[00:03]three'); const trackId = translated(doc); const track = doc.translationTracks[0];
    delete track.entries[doc.cues[1].id]; track.entries[doc.cues[2].id].sourceHash = 'old-source';
    for (const mode of ['target', 'bilingual'] as const) {
      const blocked = planSubtitleExport(doc, options({ mode, trackId }));
      expect(blocked).toMatchObject({ bytes: null, missingCount: 1, staleCount: 1, partial: false });
      expect(blocked.issues.filter(issue => ['translation_missing', 'translation_stale'].includes(issue.code)).every(issue => issue.blocking)).toBe(true);
      const skipped = back(doc, options({ mode, trackId, incomplete: 'skip' }));
      expect(skipped.plan).toMatchObject({ cueCount: 1, partial: true, missingCount: 1, staleCount: 1 });
      expect(skipped.plan.fileName).toBe('synthetic.lrc');
      const fallback = back(doc, options({ mode, trackId, incomplete: 'source-fallback' }));
      expect(fallback.plan).toMatchObject({ cueCount: 3, partial: true });
      expect(fallback.doc.cues.slice(-2).map(cue => cue.source.plain)).toEqual(['two', 'three']);
      expect(fallback.plan.issues).toContainEqual({ code: 'source_fallback', count: 2, blocking: false, confirmation: false });
    }
    track.entries[doc.cues[0].id].sourceRevision++;
    expect(planSubtitleExport(doc, options({ mode: 'target', trackId })).staleCount).toBe(2);
  });

  it('treats an empty target for nonempty source as missing and refuses an entirely skipped output', () => {
    const doc = parse('[00:01]Hello'); const trackId = translated(doc);
    doc.translationTracks[0].entries[doc.cues[0].id].text = plain('');
    expect(planSubtitleExport(doc, options({ mode: 'target', trackId, incomplete: 'skip' }))).toMatchObject({ bytes: null, cueCount: 0, missingCount: 1, partial: true });
  });

  it('keeps an empty source as an empty cue and avoids injecting an SRT delimiter around a nonempty target', () => {
    const doc = parse('1\n00:00:01,000 --> 00:00:02,000\n\n', 'srt'); const trackId = translated(doc);
    expect(back(doc, options({ format: 'srt' })).doc.cues[0].source.plain).toBe('');
    for (const order of ['source-first', 'target-first'] as const) {
      const result = back(doc, options({ mode: 'bilingual', format: 'srt', trackId, order }));
      expect(result.doc.cues).toHaveLength(1);
      expect(result.doc.cues[0].source.plain).toBe('译文1');
    }
  });
});

describe('export time projection and format losses', () => {
  it('estimates ends from the complete strictly-later time set, preserving same-time, unordered and skipped cues', () => {
    const doc = parse('[offset:+125]\n[00:05]last\n[00:01][00:01]same\n[00:03]untranslated'); const trackId = translated(doc);
    delete doc.translationTracks[0].entries[doc.cues[3].id];
    const before = structuredClone(doc);
    const config = options({ format: 'srt', mode: 'target', trackId, incomplete: 'skip', missingEnd: { mode: 'next-start', finalDurationMs: 1750 } });
    expect(planSubtitleExport(doc, { ...config, missingEnd: { mode: 'block' } }).bytes).toBeNull();
    const result = back(doc, config);
    expect(result.doc.cues.map(cue => cue.timing)).toEqual([
      { startMs: 5125, endMs: 6875, provenance: 'srt' },
      { startMs: 1125, endMs: 3125, provenance: 'srt' },
      { startMs: 1125, endMs: 3125, provenance: 'srt' },
    ]);
    expect(result.plan.issues).toContainEqual({ code: 'estimated_end', count: 3, blocking: false, confirmation: false });
    expect(doc).toEqual(before);
  });

  it('uses actual LRC milliseconds with zero implicit offset and reports omitted metadata', () => {
    const doc = parse('[ti:Title]\n[offset:-25]\n\nuntimed note\n[00:01.1][00:01.123]word');
    const result = back(doc, options());
    expect(result.text).toBe('[00:01.075]word\n[00:01.098]word\n');
    expect(result.doc.preservation.offsetMs).toBe(0);
    expect(result.doc.cues.map(cue => cue.timing.startMs)).toEqual([1075, 1098]);
    expect(result.plan.issues).toContainEqual({ code: 'metadata_omitted', count: 3, blocking: false, confirmation: true });
  });

  it('preserves nested safe SRT spans and diagnoses LRC style and multiline flattening per cue', () => {
    const doc = parse('2\n00:00:01,000 --> 00:00:03,000\n<b>A<i>B\nC</i></b><u>D</u>\n', 'srt');
    const srt = back(doc, options({ format: 'srt' }));
    expect(srt.doc.cues[0].source).toEqual(doc.cues[0].source);
    expect(srt.plan.issues).toEqual([]);
    const lrc = back(doc, options());
    expect(lrc.doc.cues[0].source).toEqual(plain('AB CD'));
    expect(lrc.plan.issues).toEqual(expect.arrayContaining([
      { code: 'styles_removed', count: 1, blocking: false, confirmation: true },
      { code: 'line_breaks_flattened', count: 1, blocking: false, confirmation: true },
      { code: 'end_times_omitted', count: 1, blocking: false, confirmation: true },
    ]));
  });

  it('normalizes a CRLF across span boundaries to one SRT body newline', () => {
    const doc = parse('2\n00:00:01,000 --> 00:00:03,000\nsafe', 'srt');
    doc.cues[0].source = { plain: 'first\r\nsecond', spans: [{ text: 'first\r', marks: ['b'] }, { text: '\nsecond', marks: ['i'] }] };
    const result = back(doc, options({ format: 'srt', newline: 'crlf' }));
    expect(result.doc.cues).toHaveLength(1);
    expect(result.doc.cues[0].source.plain).toBe('first\nsecond');
    expect(result.doc.cues[0].source.spans.map(span => span.marks)).toEqual([['b'], ['i']]);
  });

  it('preserves extended hours, zero duration and the largest safe LRC millisecond without scientific notation', () => {
    const doc = parse('1\n123:45:56,789 --> 123:45:56,789\nextended', 'srt');
    const result = back(doc, options({ format: 'srt' }));
    expect(result.doc.cues[0].timing).toEqual(doc.cues[0].timing);
    expect(result.text).toContain('123:45:56,789 --> 123:45:56,789');
    const lrc = parse('[00:01]last'); lrc.cues[0].timing.startMs = Number.MAX_SAFE_INTEGER;
    const last = back(lrc, options());
    expect(last.doc.cues[0].timing.startMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(last.text).not.toMatch(/NaN|Infinity|e\+/);
  });

  it.each(['<font color="red">text</font>', '{\\pos(1,2)}text', '<00:01.00>word', '[00:02.125]word', 'bad\u0000text'])('blocks ambiguous or unsupported LRC body %s', text => {
    const doc = parse('[00:01]safe'); doc.cues[0].source = plain(text);
    const plan = planSubtitleExport(doc, options());
    expect(plan.bytes).toBeNull(); expect(plan.issues.some(issue => issue.code === 'unsupported_text' && issue.blocking)).toBe(true);
  });

  it.each(['before\n\nafter', '\nbefore', 'before\n', 'before\n \nafter'])('blocks SRT body delimiters %j', text => {
    const doc = parse('1\n00:00:01,000 --> 00:00:02,000\nsafe', 'srt'); doc.cues[0].source = plain(text);
    expect(planSubtitleExport(doc, options({ format: 'srt' })).bytes).toBeNull();
  });

  it('rejects negative times and overflowing estimated ends without changing source evidence', () => {
    const negative = parse('[offset:-2000]\n[00:01]negative');
    const plan = planSubtitleExport(negative, options());
    expect(plan.bytes).toBeNull(); expect(plan.issues.some(issue => issue.code === 'invalid_time')).toBe(true);
    const large = parse('[00:01]last'); large.cues[0].timing.startMs = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(large);
    const overflow = planSubtitleExport(large, options({ format: 'srt', missingEnd: { mode: 'next-start', finalDurationMs: 2000 } }));
    expect(overflow.bytes).toBeNull(); expect(overflow.issues.some(issue => issue.code === 'invalid_time')).toBe(true);
    expect(large).toEqual(before);
  });
});

describe('export encoding and output bounds', () => {
  it.each(['utf-8', 'utf-16le', 'gb18030', 'shift_jis'] as const)('strictly round trips %s and selected CRLF/BOM', encoding => {
    const doc = parse('[00:01]日本語');
    for (const bom of encoding.startsWith('utf-') ? [false, true] : [false]) {
      const config = options({ encoding, bom, newline: 'crlf' }); const result = back(doc, config);
      expect(result.text).toBe('[00:01.000]日本語\r\n');
      expect(result.plan.byteLength).toBe(result.plan.bytes!.length);
      if (bom) expect([...result.plan.bytes!.subarray(0, encoding === 'utf-8' ? 3 : 2)]).toEqual(encoding === 'utf-8' ? [0xef, 0xbb, 0xbf] : [0xff, 0xfe]);
    }
  });

  it('rejects non-Unicode BOM options, substitution and unpaired Unicode surrogates', () => {
    const doc = parse('[00:01]😀');
    expect(() => planSubtitleExport(doc, options({ encoding: 'shift_jis', bom: true }))).toThrow('invalid_input');
    const plan = planSubtitleExport(doc, options({ encoding: 'shift_jis' }));
    expect(plan.bytes).toBeNull(); expect(plan.issues.some(issue => issue.code === 'encoding_unrepresentable')).toBe(true);
    doc.cues[0].source = plain('\ud800');
    expect(planSubtitleExport(doc, options()).bytes).toBeNull();
  });

  it('keeps previews bounded even when a bilingual export is larger than the source import limit', () => {
    const doc = parse(`[00:01]${'a'.repeat(3000)}`);
    expect(planSubtitleExport(doc, options()).preview).toHaveLength(2000);
    const template = parse(`[00:01]${'a'.repeat(40000)}`); const cue = template.cues[0];
    template.cues = Array.from({ length: 220 }, () => ({ ...structuredClone(cue), id: randomUUID() }));
    template.preservation.nodes[0].cueIds = template.cues.map(item => item.id);
    const trackId = translated(template);
    for (const item of template.cues) template.translationTracks[0].entries[item.id].text = plain('b'.repeat(40000));
    expect(Buffer.byteLength(template.preservation.rawText)).toBeLessThan(LIMITS.inputBytes);
    const result = planSubtitleExport(template, options({ mode: 'bilingual', trackId }));
    expect(result.byteLength).toBeGreaterThan(LIMITS.inputBytes);
    expect(result.byteLength).toBeLessThan(LIMITS.snapshotBytes);
    expect(result.preview).toHaveLength(2000);
  });

  it('stops a repeated-event projection at the 128 MiB output bound before allocating an encoded file', () => {
    const doc = parse(`[00:01]${'a'.repeat(64000)}`); const first = doc.cues[0];
    // Many LRC events can share a small source node while expanding substantially on export.
    doc.cues = Array.from({ length: 2100 }, () => ({ ...first, id: randomUUID() }));
    doc.preservation.nodes[0].cueIds = doc.cues.map(cue => cue.id);
    expect(doc.cues.length * 64000).toBeGreaterThan(LIMITS.snapshotBytes);
    expect(() => planSubtitleExport(doc, options())).toThrow('limit_exceeded');
  });

  it('does not mark complete output partial merely because fallback is available and sanitizes generated names', () => {
    const doc = parse('[00:01]Hello'); const trackId = translated(doc); doc.origin.displayName = '../unsafe/name.lrc';
    const result = planSubtitleExport(doc, options({ mode: 'target', trackId, incomplete: 'source-fallback' }));
    expect(result).toMatchObject({ partial: false, fileName: 'name.lrc' });
  });
});
