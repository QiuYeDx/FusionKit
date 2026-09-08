import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { LIMITS, validateDocument } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { decodeSubtitle, readSubtitle } from '../../electron/main/subtitle-studio/input-service';
import { sourceBytes, publishSource, unusedOutputPath } from '../../electron/main/subtitle-studio/export-service';
import { DocumentRepository } from '../../electron/main/subtitle-studio/document-repository';

const parse = (text: string, format: 'srt' | 'lrc' = 'srt') => importSubtitleText(text, { format, displayName: `fixture.${format}`, encoding: 'utf-8', digest: createHash('sha256').update(text).digest('hex') }, randomUUID);
const srt = '7\r\n00:00:01,000 --> 00:00:03,000\r\n<b>Hello <i>world</i></b>\r\nSecond line\r\n\r\n42\r\n00:00:02,000 --> 00:00:02,000\r\nHello\r\n';

describe('independent subtitle formats', () => {
  it('preserves SRT labels, CRLF, multiline, overlap, safe nested spans and identities', () => {
    const doc = parse(srt);
    expect(doc.cues.map(cue => cue.sourceLabel)).toEqual(['7', '42']);
    expect(doc.cues[0].source.plain).toBe('Hello world\nSecond line');
    expect(doc.cues[0].source.spans[1].marks).toEqual(['b', 'i']);
    expect(doc.cues[1].timing.startMs).toBeLessThan(doc.cues[0].timing.endMs!);
    expect(doc.diagnostics.map(d => d.code)).toContain('zero_duration');
    const identities = doc.cues.map(cue => cue.id);
    doc.cues.reverse();
    expect(validateDocument(doc).cues.map(cue => cue.id)).toEqual(identities.reverse());
    expect(doc.preservation.nodes.map(node => doc.preservation.rawText.slice(node.start, node.end)).join('')).toBe(srt);
    expect(sourceBytes(doc).toString()).toBe(srt);
  });
  it('expands LRC events only by source group and applies offset once', () => {
    const raw = '[ar:fixture]\n[offset:-1500]\n\n[00:01.00][00:02.125]same\n[00:01.00]different\n[00:01.00]same\n';
    const doc = parse(raw, 'lrc');
    expect(doc.cues.map(cue => cue.timing.startMs)).toEqual([-500, 625, -500, -500]);
    expect(new Set(doc.cues.map(cue => cue.id)).size).toBe(4);
    expect(doc.cues[0].nodeId).toBe(doc.cues[1].nodeId);
    expect(doc.cues[0].nodeId).not.toBe(doc.cues[3].nodeId);
    expect(doc.cues.every(cue => cue.timing.endMs === null)).toBe(true);
    expect(sourceBytes(doc).toString()).toBe(raw);
    expect(parse(sourceBytes(doc).toString(), 'lrc').cues.map(cue => cue.timing.startMs)).toEqual([-500, 625, -500, -500]);
  });
  it.each(['<script>alert(1)</script>', '<b>unclosed', '<font color="red">text</font>', '{\\an8}text'])('preserves unsupported text %s without enabling translation', text => {
    const doc = parse(`1\n00:00:00,000 --> 00:00:01,000\n${text}`);
    expect(doc.capabilities.translate).toBe(false);
    expect(doc.cues[0].source.plain).toBe(text);
    expect(doc.diagnostics[0].code).toBe('unsupported_markup');
  });
  it('retains enhanced LRC and untimed text with explicit diagnostics', () => {
    const doc = parse('[00:01.00]<00:01.00>Hello<00:01.50>world\nuntimed text', 'lrc');
    expect(doc.capabilities.translate).toBe(false);
    expect(doc.cues[0].source.plain).toContain('<00:01.00>');
    expect(doc.diagnostics.map(d => d.code)).toContain('enhanced_lrc');
    expect(doc.diagnostics.map(d => d.code)).toContain('untimed_text');
  });
  it.each(['', '\n\n', '[ar:fixture]\n'])('allows empty source documents: %j', text => {
    const doc = parse(text, 'lrc');
    expect(doc.cues).toHaveLength(0);
    expect(doc.diagnostics.map(d => d.code)).toContain('empty_document');
    expect(sourceBytes(doc).toString()).toBe(text);
  });
  it.each(['1\n00:00:02,000 --> 00:00:01,000\ntext', '1\n00:99:01,000 --> 00:00:01,000\ntext', 'not srt'])('rejects malformed SRT atomically', text => expect(() => parse(text)).toThrow('invalid_input'));
  it('rejects malformed times, duplicate offsets, oversized cues and input', () => {
    expect(() => parse('[00:99.00]bad', 'lrc')).toThrow('invalid_input');
    expect(() => parse('[offset:1]\n[offset:2]\n[00:01]a', 'lrc')).toThrow('invalid_input');
    expect(() => parse('[offset:bad]\n[00:01]a', 'lrc')).toThrow('invalid_input');
    expect(() => parse(`[00:01]${'x'.repeat(LIMITS.cueBytes + 1)}`, 'lrc')).toThrow('limit_exceeded');
    expect(() => parse('x'.repeat(LIMITS.inputBytes + 1), 'lrc')).toThrow('limit_exceeded');
    expect(() => parse(`${'[00:01]'.repeat(LIMITS.cues + 1)}x`, 'lrc')).toThrow('limit_exceeded');
    expect(() => parse('\n'.repeat(LIMITS.nodes + 1), 'lrc')).toThrow('limit_exceeded');
  });
  it('rejects duplicate identities, broken mappings, unknown schemas and invalid time', () => {
    const doc = parse(srt);
    expect(() => validateDocument({ ...doc, schemaVersion: 2 })).toThrow();
    expect(() => validateDocument({ ...doc, cues: [doc.cues[0], doc.cues[0]] })).toThrow();
    const broken = structuredClone(doc); broken.cues[0].nodeId = randomUUID();
    expect(() => validateDocument(broken)).toThrow();
    const infinite = structuredClone(doc); infinite.cues[0].timing.startMs = Infinity;
    expect(() => validateDocument(infinite)).toThrow();
  });
  it('strictly decodes the supported encodings and preserves original BOM bytes', () => {
    for (const encoding of ['utf-8', 'utf-16le', 'gb18030', 'shift_jis'] as const) {
      const raw = '[00:01.00]日本語\r\n';
      for (const bom of [false, true]) {
        const bytes = iconv.encode(raw, encoding, { addBOM: bom });
        const decoded = decodeSubtitle(bytes, encoding);
        const doc = importSubtitleText(decoded.text, { format: 'lrc', displayName: 'fixture.lrc', encoding, digest: createHash('sha256').update(bytes).digest('hex') }, randomUUID, decoded.bom);
        expect(sourceBytes(doc)).toEqual(bytes);
      }
    }
    expect(() => decodeSubtitle(Buffer.from([0xc3, 0x28]), 'utf-8')).toThrow('encoding_required');
    expect(() => decodeSubtitle(Buffer.from([0x81]), 'shift_jis')).toThrow('encoding_required');
    expect(() => decodeSubtitle(Buffer.from([0x41]), 'utf-16le')).toThrow('encoding_required');
  });
  it('imports, persists, reopens without source and exports identical bytes without mutating files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-format-'));
    try {
      const file = path.join(root, 'source.srt');
      const bytes = Buffer.from('\ufeff' + srt);
      await writeFile(file, bytes);
      const doc = await readSubtitle(file, 'utf-8');
      const repository = new DocumentRepository(path.join(root, 'documents'));
      await repository.create(doc);
      expect(await readFile(file)).toEqual(bytes);
      expect(await unusedOutputPath(root, 'source.srt')).toBe(path.join(root, 'source (1).srt'));
      await rm(file);
      const restored = await new DocumentRepository(path.join(root, 'documents')).read(doc.id);
      expect(restored.cues).toEqual(doc.cues);
      const exported = path.join(root, 'export.srt');
      await publishSource(restored, exported);
      expect(await readFile(exported)).toEqual(bytes);
      expect((await repository.list()).length).toBe(1);
      await writeFile(file, 'bad source');
      await expect(readSubtitle(file, 'utf-8')).rejects.toThrow();
      expect((await repository.list()).length).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
