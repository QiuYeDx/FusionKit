import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { LIMITS, validateDocument, type SubtitleDocument, type SubtitleText, type TextSubtitleDocument } from '../../src/subtitle-studio/domain';
import type { ExportOptions } from '../../src/subtitle-studio/export-contract';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { ASS_HEADER } from '../../src/subtitle-studio/formats/ass';
import { preservedBodies } from '../../src/subtitle-studio/formats/structure';
import { applyBilingual, hasBilingualCandidates } from '../../src/subtitle-studio/bilingual';
import { projectTranslationUnits, validateTranslationResponse } from '../../src/subtitle-studio/translation-protocol';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';
import { planSubtitleExport } from '../../electron/main/subtitle-studio/export-planner';
import { sourceBytes } from '../../electron/main/subtitle-studio/export-service';
import { readSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';

type Format = TextSubtitleDocument['origin']['format'];
const plain = (text: string): SubtitleText => ({ plain: text, spans: text ? [{ text, marks: [] }] : [] });
const digest = (text: unknown) => createHash('sha256').update(typeof text === 'string' || Buffer.isBuffer(text) ? text : JSON.stringify(text)).digest('hex');
const parse = (raw: string, format: Format) => importSubtitleText(raw, { format, displayName: `synthetic.${format}`, encoding: 'utf-8', digest: digest(raw) }, randomUUID);
const options = (format: Format, overrides: Partial<ExportOptions> = {}): ExportOptions => ({ mode: 'source', format, order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'block', missingEnd: { mode: 'next-start', finalDurationMs: 1000 }, ...overrides });
const ass = (body: string, extra = '') => ASS_HEADER + `Dialogue: 4,0:00:01.00,0:00:02.00,Default,Actor,10,20,30,,${body}\n` + extra;
const vtt = (body: string, extra = '') => `WEBVTT synthetic\n\nNOTE untouched\nmetadata, --> stays here\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:bottom\nwidth:40%\n\ncue identifier\n00:01.000 --> 00:02.000 line:10% position:30% align:start\n${body}\n\n${extra}`;
function translate(doc: SubtitleDocument, replacement = '译文') {
  const units = projectTranslationUnits(doc);
  const decoded = validateTranslationResponse(JSON.stringify({ items: units.map(unit => ({ id: unit.id, text: unit.text.replace(/Hello|world|Again|おはよう/g, replacement) })) }), units, 1024 * 1024);
  const id = randomUUID();
  doc.translationTracks.push({ id, revision: 1, language: 'zh', origin: 'ai', entries: Object.fromEntries(doc.cues.filter(cue => decoded.has(cue.id)).map(cue => [cue.id,
    { sourceRevision: cue.sourceRevision, sourceHash: digest(cue.source), text: decoded.get(cue.id)!, origin: 'ai', reviewStatus: 'unreviewed' }])) });
  return { id, units };
}
function back(doc: SubtitleDocument, config: ExportOptions) {
  const plan = planSubtitleExport(doc, config);
  expect(plan.issues.filter(issue => issue.blocking)).toEqual([]);
  expect(plan.bytes).not.toBeNull();
  const raw = iconv.decode(plan.bytes!, config.encoding);
  return { plan, raw, doc: parse(raw, config.format) };
}

describe('I3 complete VTT and ASS body workflows', () => {
  it.each(['vtt', 'ass'] as const)('reads real .%s files through bounded input and preserves original encoding/BOM evidence', async format => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-file-format-'));
    try {
      for (const encoding of (format === 'vtt' ? ['utf-8'] : ['utf-8', 'utf-16le', 'gb18030']) as TextSubtitleDocument['origin']['encoding'][]) {
        const raw = format === 'vtt' ? vtt('Hello') : ass('Hello 你好');
        const bytes = iconv.encode(raw, encoding, { addBOM: encoding !== 'gb18030' });
        const file = path.join(root, `original.${format}`); await writeFile(file, bytes);
        const doc = await readSubtitle(file, encoding);
        expect(doc.origin.format).toBe(format); expect(doc.origin.digest).toBe(digest(bytes));
        expect(sourceBytes(doc)).toEqual(bytes);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['vtt', 'ass'] as const)('%s keeps raw bytes, reopens and translates only the protected body', async format => {
    const raw = (format === 'vtt' ? vtt('<v Alice><b>Hello &amp; world</b></v>') : ass('{\\pos(90,120)\\b1}Hello, world{\\b0}\\NAgain', 'Comment: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,do not translate\n[Fonts]\nfontname: synthetic.ttf\n!attachment!\n[Unknown Future]\nopaque=data\n')).replace(/\n/g, '\r\n');
    const doc = parse(raw, format); const before = structuredClone(doc);
    expect(doc.capabilities.translate).toBe(true);
    expect(sourceBytes(doc).toString()).toBe(raw);
    expect(doc.preservation.nodes.map(node => raw.slice(node.start, node.end)).join('')).toBe(raw);
    const root = await mkdtemp(path.join(tmpdir(), 'studio-format-'));
    try {
      const repository = new DocumentRepository(path.join(root, 'docs')); await repository.create(doc);
      const reopened = await new DocumentRepository(path.join(root, 'docs')).read(doc.id);
      expect(reopened).toEqual(before);
      const { id, units } = translate(reopened);
      expect(units).toHaveLength(1);
      expect(units[0].text).not.toMatch(/pos|Actor|attachment|metadata|Alice|Dialogue|line:10%|color/);
      expect(units[0].text).toContain('<m1>');
      for (const mode of ['source', 'target', 'bilingual'] as const) {
        const result = back(reopened, options(format, { mode, trackId: id, newline: 'crlf' }));
        const originalBodies = preservedBodies(doc)!;
        const resultBodies = preservedBodies(result.doc)!;
        const originalNode = doc.preservation.nodes.find(node => node.cueIds.length)!;
        const resultNode = result.doc.preservation.nodes.find(node => node.cueIds.length)!;
        const first = originalBodies.get(originalNode.id)!; const second = resultBodies.get(resultNode.id)!;
        expect(result.raw.slice(0, first.bodyStart)).toBe(raw.slice(0, first.bodyStart));
        expect(result.raw.slice(second.bodyEnd)).toBe(raw.slice(first.bodyEnd));
        expect(result.plan.issues).toEqual([]);
        if (mode === 'source') expect(result.raw).toBe(raw);
        else expect(result.doc.cues[0].source.plain).toContain('译文');
      }
      expect(sourceBytes(reopened)).toEqual(Buffer.from(raw));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const samples: Record<Format, string> = {
    srt: '7\n00:00:01,000 --> 00:00:02,000\n<b>Hello</b>\n\n8\n00:00:03,000 --> 00:00:04,000\nAgain\n',
    lrc: '[ar:metadata]\n[00:01.000]<b>Hello</b>\n[00:03.000]Again\n',
    vtt: vtt('<b>Hello</b>', 'second\n00:03.000 --> 00:04.000\nAgain\n'),
    ass: ass('{\\b1}Hello{\\b0}', 'Dialogue: 1,0:00:03.00,0:00:04.00,Default,,0,0,0,,Again\n'),
  };
  it.each(['srt', 'lrc', 'vtt', 'ass'] as const)('round trips %s into four formats and all content modes', sourceFormat => {
    const source = parse(samples[sourceFormat], sourceFormat); const { id } = translate(source); const before = structuredClone(source);
    for (const format of ['srt', 'lrc', 'vtt', 'ass'] as const) for (const mode of ['source', 'target', 'bilingual'] as const) for (const order of ['source-first', 'target-first'] as const) {
      const result = back(source, options(format, { mode, order, trackId: id }));
      expect(result.plan.cueCount).toBe(2);
      expect(result.doc.cues).toHaveLength(mode === 'bilingual' && format === 'lrc' ? 4 : 2);
      const start = mode === 'target' || (mode === 'bilingual' && order === 'target-first') ? '译文' : 'Hello';
      expect(result.doc.cues[0].source.plain.startsWith(start)).toBe(true);
      expect(result.doc.cues[0].timing.startMs).toBe(1000);
      expect(result.doc.cues.at(-1)!.timing.startMs).toBe(3000);
    }
    expect(source).toEqual(before);
  });

  it.each(['vtt', 'ass'] as const)('%s bilingual separation maps entities/escapes to exact original ranges and suppresses old target nodes', format => {
    for (const sameNode of [true, false]) for (const sourceSide of ['first', 'second'] as const) {
      const raw = format === 'vtt' ? vtt(sameNode ? '<b>おはよう</b>\n早上好' : '<b>おはよう</b>', sameNode ? '' : '00:01.000 --> 00:02.000\n早上好\n')
        : ass(sameNode ? '{\\b1}おはよう{\\b0}\\N早上好' : '{\\b1}おはよう{\\b0}', sameNode ? '' : 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,早上好\n');
      const doc = parse(raw, format);
      expect(hasBilingualCandidates(doc)).toBe(true);
      const separated = applyBilingual(doc, { sourceSide, splitInline: false, overrides: [] }, randomUUID, cue => digest(cue.source));
      expect(separated.cues).toHaveLength(1);
      const source = sourceSide === 'first' ? 'おはよう' : '早上好'; const target = sourceSide === 'first' ? '早上好' : 'おはよう';
      expect(back(separated, options(format)).doc.cues[0].source.plain).toBe(source);
      const trackId = separated.translationTracks[0].id;
      expect(back(separated, options(format, { mode: 'target', trackId })).doc.cues[0].source.plain).toBe(target);
      expect(back(separated, options(format, { mode: 'bilingual', trackId })).doc.cues[0].source.plain).toBe(`${source}\n${target}`);
      separated.translationTracks = [];
      expect(back(separated, options(format)).raw).not.toContain(target);
      expect(sourceBytes(separated).toString()).toBe(raw);
    }
  });
});

describe('VTT and ASS bounded semantic support', () => {
  it('supports all VTT line endings, identifiers, timestamps, entities and safe whole-cue wrappers', () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const raw = vtt('<c.warning><lang ja><b>Hello</b> &amp; world&nbsp;!</lang></c>').replace(/\n/g, newline);
      const doc = parse(raw, 'vtt');
      expect(doc.cues[0].sourceLabel).toBe('cue identifier');
      expect(doc.cues[0].source.plain).toBe('Hello & world\u00a0!');
      expect(doc.capabilities.translate).toBe(true);
      expect(doc.preservation.newline).toBe(newline === '\r' ? 'cr' : newline === '\r\n' ? 'crlf' : 'lf');
      expect(sourceBytes(doc).toString()).toBe(raw);
      expect(back(doc, options('vtt')).raw).toBe(raw.replace(/\r\n|\r/g, '\n'));
    }
    expect(parse('WEBVTT\n\n00:00:01.005 --> 100:00:02.125\nx', 'vtt').cues[0].timing.endMs).toBe(360002125);
  });
  it.each(['<ruby>Hello<rt>read</rt></ruby>', 'Hello <00:01.500>world', '<b>unclosed', '<c.one>Hello</c> world', 'Hello &lt;world&gt;'])('retains complex VTT payload %s with a diagnostic and blocks model admission', body => {
    const raw = vtt(body); const doc = parse(raw, 'vtt');
    expect(doc.diagnostics.map(item => item.code)).toContain('vtt_payload_unsupported');
    expect(doc.capabilities.translate).toBe(false);
    expect(() => projectTranslationUnits(doc)).toThrow('unsupported_feature');
    expect(back(doc, options('vtt')).raw).toBe(raw);
  });
  it('keeps standalone ASS drawings out of translation while preserving drawings, comments and attachments', () => {
    const raw = ass('Hello', 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 100{\\p0}\nComment: untouched\n[Graphics]\nfilename: picture\n!!!\n');
    const doc = parse(raw, 'ass'); const { id, units } = translate(doc);
    expect(doc.cues).toHaveLength(1); expect(units[0].text).toBe('Hello');
    expect(doc.diagnostics.map(item => item.code)).toContain('ass_drawing');
    expect(back(doc, options('ass', { mode: 'target', trackId: id })).raw).toContain('{\\p1}m 0 0 l 100 100{\\p0}');
    expect(back(doc, options('vtt')).plan.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'effects_omitted', confirmation: true }), expect.objectContaining({ code: 'opaque_omitted', confirmation: true })]));
  });
  it.each(['{\\k20}Hel{\\k30}lo', '{\\p1}m 0 0{\\p0}Hello', 'Hel{\\pos(1,2)}lo', 'Hello{unplaced comment} world'])('blocks ASS controls tied to original text positions: %s', body => {
    const raw = ass(body); const doc = parse(raw, 'ass');
    expect(doc.capabilities.translate).toBe(false);
    expect(() => projectTranslationUnits(doc)).toThrow('unsupported_feature');
    expect(back(doc, options('ass')).raw).toBe(raw);
    const id = randomUUID(); doc.translationTracks.push({ id, revision: 1, language: 'zh', entries: { [doc.cues[0].id]: { sourceRevision: 1, sourceHash: digest(doc.cues[0].source), text: plain('译文'), origin: 'human', reviewStatus: 'reviewed' } } });
    expect(planSubtitleExport(doc, options('ass', { mode: 'target', trackId: id })).issues).toContainEqual(expect.objectContaining({ code: 'unsupported_text', blocking: true }));
  });
  it('decodes ASS hard/soft line breaks, hard spaces, interior basic marks, reordered event fields and literal commas', () => {
    const raw = '[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\n[Events]\nFormat: Start, End, Style, Text\nDialogue: 0:00:01.00,0:00:02.00,Default,Hello\\nworld\\h!{\\i1},more{\\i0}\n';
    const doc = parse(raw, 'ass');
    expect(doc.cues[0].source.plain).toBe('Hello\nworld\u00a0!,more');
    expect(doc.cues[0].source.spans.at(-1)!.marks).toEqual(['i']);
    const { id } = translate(doc);
    expect(back(doc, options('ass', { mode: 'target', trackId: id })).doc.cues[0].source.plain).toContain('译文\n译文');
    expect(parse(ass('Hello\\nworld'), 'ass').cues[0].source.plain).toBe('Hello world');
  });
  it('inherits ASS basic style marks and does not flatten animated override targets into static bold', () => {
    const raw = ass('{\\t(0,1000,\\b1)}Hello').replace('&H00000000,0,0,0,0,100', '&H00000000,0,-1,-1,0,100');
    const doc = parse(raw, 'ass');
    expect(doc.cues[0].source.spans).toEqual([{ text: 'Hello', marks: ['i', 'u'] }]);
    const { id, units } = translate(doc); expect(units[0].text).toContain('<m1><m2>');
    for (const mode of ['target', 'bilingual'] as const) {
      const result = back(doc, options('ass', { mode, trackId: id }));
      expect(result.raw).toContain('{\\t(0,1000,\\b1)}');
      expect(result.doc.cues[0].source.spans.filter(span => span.text.trim()).every(span => span.marks.includes('i') && span.marks.includes('u') && !span.marks.includes('b'))).toBe(true);
    }
  });
  it('keeps VTT empty-payload replacements and CRLF bilingual bodies parseable', () => {
    const doc = parse('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n\r\n00:03.000 --> 00:04.000\r\nHello\r\n', 'vtt');
    const { id } = translate(doc);
    doc.translationTracks[0].entries[doc.cues[0].id] = { sourceRevision: 1, sourceHash: digest(doc.cues[0].source), text: plain('译文'), origin: 'human', reviewStatus: 'reviewed' };
    const result = back(doc, options('vtt', { mode: 'bilingual', trackId: id }));
    expect(result.doc.cues.map(cue => cue.source.plain)).toEqual(['译文', 'Hello\n译文']);
    expect(result.raw).not.toContain('\r\r');
    expect(result.raw).not.toContain('\r');
    expect(back(doc, options('vtt', { mode: 'bilingual', trackId: id, newline: 'crlf' })).raw).toBe(result.raw.replace(/\n/g, '\r\n'));
    const eof = parse('WEBVTT\n\n00:01.000 --> 00:02.000', 'vtt');
    eof.translationTracks = [{ id, revision: 1, language: 'zh', entries: { [eof.cues[0].id]: { sourceRevision: 1, sourceHash: digest(eof.cues[0].source), text: plain('译文'), origin: 'human', reviewStatus: 'reviewed' } } }];
    expect(back(eof, options('vtt', { mode: 'target', trackId: id })).doc.cues[0].source.plain).toBe('译文');
  });
  it('retains unknown VTT blocks and requires an explicit loss when rebuilding another format', () => {
    const raw = vtt('Hello', 'X-FUTURE-METADATA\nunknown body = retained\n\n');
    const doc = parse(raw, 'vtt'); const { id } = translate(doc);
    expect(back(doc, options('vtt', { mode: 'target', trackId: id })).raw).toContain('X-FUTURE-METADATA\nunknown body = retained');
    expect(back(doc, options('srt')).plan.issues).toContainEqual(expect.objectContaining({ code: 'opaque_omitted', confirmation: true }));
  });
  it('rejects unmapped preserved dialogue instead of leaking it into a target export', () => {
    const doc = parse(ass('Hello', 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Again\n'), 'ass');
    const removed = doc.cues.pop()!;
    doc.preservation.nodes.find(node => node.id === removed.nodeId)!.cueIds = [];
    expect(() => planSubtitleExport(doc, options('ass'))).toThrow('invalid_input');
  });
  it.each(['WEBVTT\n00:01.000 --> 00:02.000\nx', 'WEBVTT\n\n00:01.000 --> 00:01.000\nx', 'WEBVTT\n\n00:99.000 --> 00:02.000\nx', 'WEBVTT\n\n00:02.000 --> 00:03.000\nx\n\n00:01.000 --> 00:02.000\ny'])('rejects malformed VTT timing/header: %j', raw => expect(() => parse(raw, 'vtt')).toThrow('invalid_input'));
  it('rejects unsafe ASS dialect/field layouts and bounded inputs atomically', () => {
    expect(() => parse(ASS_HEADER.replace('v4.00+', 'v4.00'), 'ass')).toThrow('unsupported_feature');
    expect(() => parse(ASS_HEADER.replace('Effect, Text', 'Text, Effect'), 'ass')).toThrow('unsupported_feature');
    expect(() => parse(ass('x').replace('0:00:02.00', '0:00:00.50'), 'ass')).toThrow('invalid_input');
    expect(() => parse(ass('x'.repeat(LIMITS.cueBytes + 1)), 'ass')).toThrow('limit_exceeded');
    expect(() => parse(vtt('x'.repeat(LIMITS.cueBytes + 1)), 'vtt')).toThrow('limit_exceeded');
    const unicode = '🚀'.repeat(LIMITS.cueBytes / 4);
    expect(parse(ass(unicode), 'ass').cues[0].source.plain).toBe(unicode);
    expect(parse(vtt(unicode), 'vtt').cues[0].source.plain).toBe(unicode);
    expect(() => parse(vtt(unicode + 'x'), 'vtt')).toThrow('limit_exceeded');
  });
});

describe('four-format projection loss and partial policies', () => {
  it('reports real metadata/layout/effects/precision losses and UTF-8 requirements', () => {
    const doc = parse(ass('{\\pos(90,120)\\fad(200,300)}Hello'), 'ass');
    const result = back(doc, options('vtt'));
    for (const code of ['metadata_omitted', 'opaque_omitted', 'positioning_omitted', 'effects_omitted', 'styles_removed']) expect(result.plan.issues).toContainEqual(expect.objectContaining({ code, confirmation: true, blocking: false }));
    const fractional = parse('1\n00:00:01,005 --> 00:00:02,004\nHello\n', 'srt');
    const rounded = back(fractional, options('ass'));
    expect(rounded.doc.cues[0].timing).toMatchObject({ startMs: 1010, endMs: 2000 });
    expect(rounded.plan.issues).toContainEqual(expect.objectContaining({ code: 'timing_precision_changed', confirmation: true }));
    const tiny = parse('1\n00:00:01,001 --> 00:00:01,004\nx', 'srt');
    expect(planSubtitleExport(tiny, options('ass')).issues).toContainEqual(expect.objectContaining({ code: 'invalid_time', blocking: true }));
    for (const format of ['vtt', 'ass'] as const) expect(planSubtitleExport(fractional, options(format, { encoding: 'utf-16le' })).issues).toContainEqual(expect.objectContaining({ code: 'encoding_not_supported', blocking: true }));
  });
  it.each(['vtt', 'ass'] as const)('%s never revives skipped or removed translations and retains nonbody data', format => {
    const doc = parse(format === 'vtt' ? vtt('Hello', 'second\n00:03.000 --> 00:04.000\nAgain\n') : ass('Hello', 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Again\n'), format);
    const { id } = translate(doc); delete doc.translationTracks[0].entries[doc.cues[1].id];
    expect(planSubtitleExport(doc, options(format, { mode: 'target', trackId: id })).bytes).toBeNull();
    const skipped = back(doc, options(format, { mode: 'target', trackId: id, incomplete: 'skip' }));
    expect(skipped.doc.cues).toHaveLength(1); expect(skipped.raw).not.toContain('Again'); expect(skipped.plan.partial).toBe(true);
    expect(skipped.raw).toContain(format === 'vtt' ? 'STYLE' : '[V4+ Styles]');
    const fallback = back(doc, options(format, { mode: 'target', trackId: id, incomplete: 'source-fallback' }));
    expect(fallback.doc.cues[1].source.plain).toBe('Again');
    doc.translationTracks[0].entries[doc.cues[0].id].sourceHash = 'stale';
    expect(planSubtitleExport(doc, options(format, { mode: 'target', trackId: id })).staleCount).toBe(1);
    expect(planSubtitleExport(doc, options(format, { mode: 'target' })).issues).toContainEqual(expect.objectContaining({ code: 'track_missing', blocking: true }));
  });
  it('estimates end times for both new formats, and orders canonical WebVTT without losing overlapping events', () => {
    const doc = parse('[00:03]Again\n[00:01]Hello\n[00:01]world', 'lrc');
    for (const format of ['vtt', 'ass'] as const) {
      expect(planSubtitleExport(doc, options(format, { missingEnd: { mode: 'block' } })).bytes).toBeNull();
      const result = back(doc, options(format));
      expect(result.plan.issues).toContainEqual(expect.objectContaining({ code: 'estimated_end', count: 3 }));
      expect(result.doc.cues).toHaveLength(3);
      expect(result.doc.cues.every(cue => cue.timing.endMs! > cue.timing.startMs)).toBe(true);
    }
  });
  it('exports both new formats from immutable media evidence', () => {
    const media = transcriptToDocument({ schemaVersion: 1, source: { displayName: 'synthetic.wav', durationMs: 4000 },
      model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cpu' },
      segments: [{ id: 'one', startMs: 1000, endMs: 2000, text: 'Hello' }] });
    const before = structuredClone(media); const { id } = translate(media);
    for (const format of ['vtt', 'ass'] as const) for (const mode of ['source', 'target', 'bilingual'] as const) {
      const result = back(media, options(format, { mode, trackId: id }));
      expect(result.doc.cues).toHaveLength(1);
      expect(result.plan.issues).toContainEqual(expect.objectContaining({ code: 'transcription_evidence_omitted', confirmation: true }));
    }
    expect(media.preservation).toEqual(before.preservation); expect(validateDocument(media).schemaVersion).toBe(2);
  });
});
