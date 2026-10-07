import { describe, expect, it } from 'vitest';
import { extractSubtitle, type ExtractParams } from '../../electron/main/extraction/extractor';

const extract = (fileContent: string, fileType: ExtractParams['fileType'], keep: ExtractParams['keep']) =>
  extractSubtitle({ fileName: `fixture.${fileType.toLowerCase()}`, fileContent, fileType, keep });

const ASS_HEAD = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: CN,Arial,40\nStyle: JP,Arial,30\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

describe('subtitle language extractor', () => {
  it('keeps the LRC and SRT behaviour and output names', () => {
    const lrc = '[ti:x]\n[00:01.00]おはようございます\n[00:01.00]早上好\n[00:02.00]ありがとう\n';
    expect(extract(lrc, 'LRC', 'ZH').outputContent).toBe('[00:01.00]早上好');
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n早上好\nおはようございます\n\n2\n00:00:03,000 --> 00:00:04,000\nありがとう\n';
    expect(extract(srt, 'SRT', 'JA')).toEqual({ outputFileName: 'fixture.srt', outputContent: '1\n00:00:01,000 --> 00:00:02,000\nおはようございます\n\n2\n00:00:03,000 --> 00:00:04,000\nありがとう' });
  });

  it('ignores markup when detecting a line language but keeps it in the output', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<font color="#fff">你好，世界</font>\n<i>♪</i>\n';
    expect(extract(srt, 'SRT', 'ZH').outputContent).toBe('1\n00:00:01,000 --> 00:00:02,000\n<font color="#fff">你好，世界</font>');
  });

  it('filters VTT cues while keeping the header, metadata blocks, identifiers and settings', () => {
    const vtt = 'WEBVTT\r\n\r\nNOTE bilingual\r\n\r\nintro\r\n00:01.000 --> 00:02.000 line:90%\r\nGood morning\r\n<i>早上好</i>\r\n\r\n00:03.000 --> 00:04.000\r\n谢谢\r\n';
    expect(extract(vtt, 'VTT', 'EN').outputContent).toBe('WEBVTT\n\nNOTE bilingual\n\nintro\n00:01.000 --> 00:02.000 line:90%\nGood morning');
    expect(extract(vtt, 'VTT', 'ZH').outputContent).toContain('intro\n00:01.000 --> 00:02.000 line:90%\n<i>早上好</i>\n\n00:03.000 --> 00:04.000\n谢谢');
  });

  it('filters SBV blocks, splitting [br] line breaks', () => {
    const sbv = '0:00:01.000,0:00:02.000\nGood morning[br]早上好\n\n0:00:03.000,0:00:04.000\nThanks\n谢谢\n';
    expect(extract(sbv, 'SBV', 'ZH').outputContent).toBe('0:00:01.000,0:00:02.000\n早上好\n\n0:00:03.000,0:00:04.000\n谢谢');
  });

  it('splits ASS dialogue on \\N and carries override tags of removed parts forward', () => {
    const ass = ASS_HEAD + 'Dialogue: 0,0:00:01.00,0:00:02.00,CN,,0,0,0,,{\\an8}早上好\\N{\\fs30}おはようございます\n';
    expect(extract(ass, 'ASS', 'JA').outputContent).toBe(ASS_HEAD + 'Dialogue: 0,0:00:01.00,0:00:02.00,CN,,0,0,0,,{\\an8}{\\fs30}おはようございます\n');
    expect(extract(ass, 'ASS', 'ZH').outputContent).toBe(ASS_HEAD + 'Dialogue: 0,0:00:01.00,0:00:02.00,CN,,0,0,0,,{\\an8}早上好\n');
  });

  it('groups same-time ASS events and leaves comments, drawings and other sections untouched', () => {
    const events = [
      'Comment: 0,0:00:00.00,0:00:01.00,CN,,0,0,0,,注释, with comma',
      'Dialogue: 0,0:00:01.00,0:00:02.00,CN,,0,0,0,,早上好，大家',
      'Dialogue: 0,0:00:01.00,0:00:02.00,JP,,0,0,0,,おはようございます',
      'Dialogue: 0,0:00:03.00,0:00:04.00,JP,,0,0,0,,ありがとう',
      'Dialogue: 0,0:00:03.00,0:00:04.00,CN,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}',
    ];
    const ass = ASS_HEAD + events.join('\r\n') + '\r\n';
    expect(extract(ass, 'ASS', 'ZH').outputContent).toBe(ASS_HEAD + [events[0], events[1], events[4]].join('\n') + '\n');
    expect(extract(ass, 'ASS', 'JA').outputContent).toBe(ASS_HEAD + [events[0], events[2], events[3], events[4]].join('\n') + '\n');
  });

  it('handles SSA dialogue with the Marked field', () => {
    const ssa = '[Script Info]\nScriptType: v4.00\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Good morning\\N早上好\n';
    expect(extract(ssa, 'SSA', 'EN')).toEqual({ outputFileName: 'fixture.ssa', outputContent: ssa.replace('\\N早上好', '') });
  });
});
