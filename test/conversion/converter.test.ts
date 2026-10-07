import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertSubtitle, type SubtitleConvertFormat } from '../../electron/main/conversion/converter';
import { importSubtitleText } from '../../src/subtitle-studio/formats/import';
import { ASS_HEADER, SSA_HEADER } from '../../src/subtitle-studio/formats/ass';

const FORMATS: SubtitleConvertFormat[] = ['LRC', 'SRT', 'VTT', 'ASS', 'SSA', 'SBV'];
const convert = (fileContent: string, from: SubtitleConvertFormat, to: SubtitleConvertFormat, fileName = `fixture.${from.toLowerCase()}`) =>
  convertSubtitle({ fileName, fileContent, from, to, defaultDurationMs: 2000 });
/** The studio importer is strict, so a successful import proves the output is well formed. */
const studioImport = (raw: string, format: SubtitleConvertFormat) => {
  const lower = format.toLowerCase() as 'srt' | 'lrc' | 'vtt' | 'ass' | 'ssa' | 'sbv';
  return importSubtitleText(raw, { format: lower, displayName: `out.${lower}`, encoding: 'utf-8', digest: createHash('sha256').update(raw).digest('hex') }, randomUUID);
};

const SAMPLES: Record<SubtitleConvertFormat, string> = {
  LRC: '[ti:Fixture]\n[00:01.00]Hello\n[00:03.50]<i>World</i>\n[00:06.00]Last line\n',
  SRT: '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello\r\n\r\n2\r\n00:00:03,500 --> 00:00:06,000\r\n<i>World</i>\r\nSecond line\r\n\r\n3\r\n00:00:06,000 --> 00:00:08,000\r\nLast line\r\n',
  VTT: 'WEBVTT\n\nNOTE comment\n\nintro\n00:01.000 --> 00:03.500 line:90%\nHello\n\n00:00:03.500 --> 00:00:06.000\n<i.yellow>World</i>\n<v Bob>Second line</v>\n\n00:06.000 --> 00:08.000\nLast &amp; line\n',
  ASS: ASS_HEADER + 'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello\nDialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\i1}World{\\i0}\\NSecond line\nDialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,Last line\n',
  SSA: SSA_HEADER + 'Dialogue: Marked=0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello\nDialogue: Marked=0,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\i1}World{\\i0}\\NSecond line\nDialogue: Marked=0,0:00:06.00,0:00:08.00,Default,,0,0,0,,Last line\n',
  SBV: '0:00:01.000,0:00:03.500\nHello\n\n0:00:03.500,0:00:06.000\nWorld\nSecond line\n\n0:00:06.000,0:00:08.000\nLast line\n',
};

describe('classic subtitle converter', () => {
  it.each(FORMATS.flatMap(from => FORMATS.filter(to => to !== from).map(to => [from, to] as const)))('converts %s to %s into a well-formed file', (from, to) => {
    const result = convert(SAMPLES[from], from, to);
    expect(result.outputFileName).toBe(`fixture.${to.toLowerCase()}`);
    const doc = studioImport(result.outputContent, to);
    expect(doc.cues.map(cue => cue.timing.startMs)).toEqual([1000, 3500, 6000]);
    if (to !== 'LRC') expect(doc.cues.map(cue => cue.timing.endMs)).toEqual([3500, 6000, 8000]);
    expect(doc.cues[0].source.plain).toBe('Hello');
    expect(doc.cues[2].source.plain).toMatch(/^Last (&|line)/);
  });

  it('keeps the LRC expansion rules: multi-tags, same-time merge, minimum and default durations', () => {
    const { outputContent } = convert('[ar:x]\n[00:01.00][00:05.00]Repeat\n[00:01.00]Same time\n[00:01.10]Too close\n[00:09.5]End\n', 'LRC', 'SRT');
    expect(outputContent).toBe(
      '1\n00:00:01,000 --> 00:00:01,300\nRepeat\nSame time\n\n'
      + '2\n00:00:01,100 --> 00:00:05,000\nToo close\n\n'
      + '3\n00:00:05,000 --> 00:00:09,500\nRepeat\n\n'
      + '4\n00:00:09,500 --> 00:00:11,500\nEnd\n',
    );
  });

  it('flattens multi-line cues and strips markup when writing LRC', () => {
    const { outputContent } = convert(SAMPLES.SRT, 'SRT', 'LRC');
    expect(outputContent).toBe('[00:01.00]Hello\n[00:03.50]World Second line\n[00:06.00]Last line\n');
  });

  it('reads ASS styles, overrides, drawings, comments, layers and event order', () => {
    const raw = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Bold, Italic\nStyle: Default,Arial,0,0\nStyle: Thought,Arial,0,-1\n\n'
      + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
      + 'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\an8\\pos(10,10)}Sign, with comma\n'
      + 'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hidden\n'
      + 'Dialogue: 0,0:00:01.00,0:00:02.00,Thought,,0,0,0,,thinking {\\rDefault}aloud\n'
      + 'Dialogue: 1,0:00:01.00,0:00:02.00,Thought,,0,0,0,,thinking {\\rDefault}aloud\n'
      + 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\b1}bold{\\b0} hard\\hspace{note}\\Nline\n'
      + 'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n';
    expect(convert(raw, 'ASS', 'SRT').outputContent).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\n<i>thinking </i>aloud\n\n'
      + '2\n00:00:03,000 --> 00:00:04,000\n<b>bold</b> hard space\nline\n\n'
      + '3\n00:00:05,000 --> 00:00:06,000\n{\\an8}Sign, with comma\n',
    );
    expect(convert(raw, 'ASS', 'VTT').outputContent).toContain('00:00:05.000 --> 00:00:06.000\nSign, with comma\n');
  });

  it('writes ASS and SSA with override tags, hard breaks and centisecond times', () => {
    const srt = '1\n00:00:01,234 --> 00:00:02,000\n{\\an8}<i>Hi</i> <font color="red">there</font>\nnext\n';
    const ass = convert(srt, 'SRT', 'ASS').outputContent;
    expect(ass.startsWith(ASS_HEADER)).toBe(true);
    expect(ass).toContain('Dialogue: 0,0:00:01.23,0:00:02.00,Default,,0,0,0,,{\\an8\\i1}Hi{\\i0} there\\Nnext\n');
    const ssa = convert(srt, 'SRT', 'SSA').outputContent;
    expect(ssa.startsWith(SSA_HEADER)).toBe(true);
    expect(ssa).toContain('Dialogue: Marked=0,0:00:01.23,');
    expect(studioImport(ssa, 'SSA').cues[0].source.plain).toBe('Hi there\nnext');
  });

  it('escapes and decodes WebVTT text entities', () => {
    expect(convert('1\n00:00:01,000 --> 00:00:02,000\nTom & Jerry <3\n', 'SRT', 'VTT').outputContent).toContain('Tom &amp; Jerry &lt;3');
    expect(convert(SAMPLES.VTT, 'VTT', 'SRT').outputContent).toContain('<i>World</i>\nSecond line');
    expect(convert(SAMPLES.VTT, 'VTT', 'SRT').outputContent).toContain('Last & line');
  });

  it('reads and writes SBV including [br] breaks and hours', () => {
    const { outputContent } = convert('1:02:03.004,1:02:05.000\nfirst[br]second\n', 'SBV', 'SRT');
    expect(outputContent).toBe('1\n01:02:03,004 --> 01:02:05,000\nfirst\nsecond\n');
    expect(convert(outputContent, 'SRT', 'SBV').outputContent).toBe('1:02:03.004,1:02:05.000\nfirst\nsecond\n');
  });

  it('strips BOMs, applies the media-extension option and rejects unusable inputs', () => {
    expect(convert(`﻿${SAMPLES.SRT}`, 'SRT', 'VTT').outputContent.startsWith('WEBVTT\n\n00:00:01.000')).toBe(true);
    expect(convertSubtitle({ fileName: 'song.wav.ass', fileContent: SAMPLES.ASS, from: 'ASS', to: 'SRT', stripMediaExt: true }).outputFileName).toBe('song.srt');
    expect(() => convert(SAMPLES.SRT, 'SRT', 'SRT')).toThrow('Unsupported conversion');
    expect(() => convert('not a subtitle', 'SRT', 'ASS')).toThrow('No subtitle entries');
  });

  it.each(readdirSync(path.join(__dirname, '../subtitles')).filter(name => name.endsWith('.lrc')))('round-trips sample %s through every timed format', name => {
    const lrc = readFileSync(path.join(__dirname, '../subtitles', name), 'utf-8');
    const srt = convert(lrc, 'LRC', 'SRT').outputContent;
    const expected = studioImport(srt, 'SRT').cues.map(cue => [cue.timing.startMs, cue.source.plain]);
    for (const format of ['VTT', 'ASS', 'SSA', 'SBV'] as const) {
      const converted = convert(srt, 'SRT', format).outputContent;
      const back = studioImport(convert(converted, format, 'SRT').outputContent, 'SRT');
      // ASS/SSA store centiseconds.
      const precision = format === 'ASS' || format === 'SSA' ? 10 : 1;
      expect(back.cues.map(cue => [cue.timing.startMs, cue.source.plain]))
        .toEqual(expected.map(([start, text]) => [Math.round((start as number) / precision) * precision, text]));
    }
  });
});
