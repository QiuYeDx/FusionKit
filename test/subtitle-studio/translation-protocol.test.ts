import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { projectTranslationUnits, sourceFingerprint, validateTranslationResponse } from '../../src/subtitle-studio/translation-protocol';

const parse = (text: string, format: 'srt' | 'lrc' = 'srt') => importSubtitleText(text, {
  format, displayName: 'private-name.srt', encoding: 'utf-8', digest: 'a'.repeat(64),
}, randomUUID);
const srt = (text: string) => parse(`42\n00:00:01,000 --> 00:00:03,000\n${text}`);
const response = (texts: string[]) => JSON.stringify({ items: texts.map((text, index) => ({ id: `u${index + 1}`, text })) });
const validate = (content: string, doc = srt('source'), maxBytes = 1024 * 1024) => validateTranslationResponse(content, projectTranslationUnits(doc), maxBytes);

describe('subtitle studio text translation protocol', () => {
  it('projects only body text and local IDs without filtering date, labels or time-like body content', () => {
    const doc = srt('Today is 2026-09-09, item 42, and 00:00:01,000 is spoken text.');
    doc.cues[0].sourceRevision = 4;
    const [unit] = projectTranslationUnits(doc);
    expect(unit).toMatchObject({ id: 'u1', cueId: doc.cues[0].id, sourceRevision: 4, text: doc.cues[0].source.plain, protectedMarks: [] });
    expect(unit.text).not.toContain('-->');
    expect(unit.text).not.toContain(doc.origin.displayName);
    expect(unit.sourceHash).toBe(sourceFingerprint(doc.cues[0]));
    const fingerprint = unit.sourceHash;
    doc.cues[0].timing.startMs++;
    doc.cues[0].timingRevision++;
    expect(sourceFingerprint(doc.cues[0])).toBe(fingerprint);
    doc.cues[0].source.spans[0].marks = ['b'];
    expect(sourceFingerprint(doc.cues[0])).not.toBe(fingerprint);
  });

  it('retains distinct LRC events, even when their source text or time is identical', () => {
    const doc = parse('[ar:private metadata]\n[offset:20]\n[00:01][00:02]same\n[00:01]same\n[00:03]other', 'lrc');
    const units = projectTranslationUnits(doc);
    expect(units.map(unit => ({ id: unit.id, text: unit.text }))).toEqual([
      { id: 'u1', text: 'same' }, { id: 'u2', text: 'same' }, { id: 'u3', text: 'same' }, { id: 'u4', text: 'other' },
    ]);
    expect(new Set(units.map(unit => unit.cueId)).size).toBe(4);
    expect(units.map(unit => unit.text).join('')).not.toMatch(/private|offset|00:0/);
  });

  it('maps unordered IDs without changing source or timeline and preserves all translated whitespace', () => {
    const doc = parse('[00:01]first\n[00:02]second', 'lrc');
    const before = structuredClone(doc);
    const result = validate(JSON.stringify({ items: [{ id: 'u2', text: '  second\n\nline\t \r\n' }, { id: 'u1', text: ' first ' }] }), doc);
    expect(result.get(doc.cues[0].id)).toEqual({ plain: ' first ', spans: [{ text: ' first ', marks: [] }] });
    expect(result.get(doc.cues[1].id)?.plain).toBe('  second\n\nline\t \r\n');
    expect(doc).toEqual(before);
  });

  it('round-trips nested styles while allowing translated multiline text and sibling reordering', () => {
    const doc = srt('<b>bold <i>nested</i></b> normal <u>underlined</u>');
    const [unit] = projectTranslationUnits(doc);
    expect(unit.text).toBe('<m1>bold <m2>nested</m2></m1> normal <m3>underlined</m3>');
    const result = validate(response(['<m3>underline</m3> plain <m1>bold\n<m2>nested\nline</m2></m1>']), doc).get(unit.cueId);
    expect(result).toEqual({ plain: 'underline plain bold\nnested\nline', spans: [
      { text: 'underline', marks: ['u'] }, { text: ' plain ', marks: [] },
      { text: 'bold\n', marks: ['b'] }, { text: 'nested\nline', marks: ['b', 'i'] },
    ] });
  });

  it.each([
    '{"items":', '{"items":[]}', '{"items":[{"id":"u2","text":"unknown"}]}',
    '{"items":[{"id":"u1","text":null}]}', '{"items":[{"id":"u1","text":2}]}',
    '{"items":[{"id":"u1","text":"ok","extra":1}]}', '{"items":[{"id":"u1","text":"ok"}],"extra":1}',
    '```json\n{"items":[{"id":"u1","text":"ok"}]}\n```', 'null', '[]',
  ])('rejects malformed response shape or incomplete IDs: %s', content => {
    expect(() => validate(content)).toThrow('translation_protocol_invalid');
  });

  it('rejects duplicate IDs and invalid late items without exposing a partial batch', () => {
    const doc = parse('[00:01]first\n[00:02]second', 'lrc');
    expect(() => validate('{"items":[{"id":"u1","text":"one"},{"id":"u1","text":"two"}]}', doc)).toThrow('translation_protocol_invalid');
    expect(() => validate(response(['valid first', '\u0000']), doc)).toThrow('translation_protocol_invalid');
    expect(() => validate('{"items":[{"id":"u1","text":"one"},{"id":"unknown","text":"two"}]}', doc)).toThrow('translation_protocol_invalid');
    expect(doc.translationTracks).toEqual([]);
  });

  it.each([
    '<m1>one</m1>', '<m1>one<m2>two</m1></m2>', '<m1>one</m1><m2>two</m2>',
    '<m1><m2>one</m2><m2>again</m2></m1>', '<m1><m2>one</m2><m3>unknown</m3></m1>',
    '<m1><m2>one</m2></m1></m1>', '<m1><m2>one</m2>', '<m1><m2>one</m2></m1><m1000>unknown</m1000>',
    '<m01><m2>one</m2></m01>', '<m1><m2>one</m2></m1><script>alert(1)</script>',
  ])('rejects missing, duplicate, unknown or structurally changed protection tokens: %s', text => {
    expect(() => validate(response([text]), srt('<b>one<i>two</i></b>'))).toThrow('translation_protocol_invalid');
  });

  it.each(['', ' \t\r\n ', '\u0000', '\u0007', '\u000b', '\u001b', '\u007f', '\u0085', '\ud800', '\udc00', 'a\ud800z', '\ud800\ud800'])('rejects blank output, controls and invalid Unicode: %j', text => {
    expect(() => validate(response([text]))).toThrow('translation_protocol_invalid');
  });

  it('accepts valid Unicode and bounded long content without silently truncating it', () => {
    const text = '\ud83d\ude80\u4e2d\u6587e\u0301\u200d';
    expect([...validate(response([text])).values()][0].plain).toBe(text);
    const longest = '\u4e2d'.repeat(Math.floor(LIMITS.cueBytes / 3));
    expect([...validate(response([longest])).values()][0].plain).toBe(longest);
    expect(() => validate(response([longest + '\u4e2d']))).toThrow('translation_protocol_invalid');
    expect(() => validate(response(['x'.repeat(LIMITS.cueBytes + 1)]))).toThrow('translation_protocol_invalid');
    expect(() => validate(response(['\u4e2d'.repeat(100)]), srt('source'), 200)).toThrow('limit_exceeded');
  });

  it('skips empty cue bodies and refuses documents without translatable content or capability', () => {
    const doc = parse('[00:01]\n[00:02] \t\n[00:03]actual', 'lrc');
    expect(projectTranslationUnits(doc).map(unit => ({ id: unit.id, text: unit.text }))).toEqual([{ id: 'u1', text: 'actual' }]);
    for (const text of ['[00:01]\n[00:02] \t', '[ar:metadata]', '[00:01]<font>unsupported</font>']) {
      expect(() => projectTranslationUnits(parse(text, 'lrc'))).toThrow('unsupported_feature');
    }
    const surrogate = srt('valid');
    surrogate.cues[0].source = { plain: '\ud800', spans: [{ text: '\ud800', marks: [] }] };
    expect(() => projectTranslationUnits(surrogate)).toThrow('unsupported_feature');
  });

  it('bounds protection nodes, nesting depth and response batch resources', () => {
    const maxDepth = srt(`${'<b>'.repeat(32)}body${'</b>'.repeat(32)}`);
    const [unit] = projectTranslationUnits(maxDepth);
    expect(validate(response([unit.text]), maxDepth).get(unit.cueId)?.spans[0].marks).toHaveLength(32);
    expect(() => projectTranslationUnits(srt(`${'<b>'.repeat(33)}body${'</b>'.repeat(33)}`))).toThrow('unsupported_feature');
    expect(projectTranslationUnits(srt('<b>x</b> '.repeat(512)))[0].protectedMarks).toHaveLength(512);
    expect(() => projectTranslationUnits(srt('<b>x</b> '.repeat(513)))).toThrow('limit_exceeded');
    const units = projectTranslationUnits(parse(Array.from({ length: 101 }, () => '[00:01]source').join('\n'), 'lrc'));
    expect(() => validateTranslationResponse(response(units.map(() => 'target')), units, 1024 * 1024)).toThrow('limit_exceeded');
  });
});
