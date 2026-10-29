import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { NAMING_POLICY, isNameLanguage, outputBaseName, outputFileName, sanitizeBaseName, type OutputFileNameInput } from '../../../electron/main/media-converter/plan/naming';

/**
 * Output names (module-encode design §6): cleaned for Windows, never a device name, never with
 * hidden bidirectional controls, cut by code points to fit 240 characters, refused when the
 * folder leaves too little room. Paths are built for the host, so the lengths are exact.
 */

const ROOT = path.parse(process.cwd()).root;
/** A folder whose own path is exactly `length` characters long. */
const folder = (length: number) => {
  const directory = ROOT + 'd'.repeat(length - ROOT.length);
  expect(directory).toHaveLength(length);
  return directory;
};
const SHORT = folder(20);
const name = (input: Partial<OutputFileNameInput> & Pick<OutputFileNameInput, 'sourceFileName' | 'baseName' | 'extension'>) => {
  const result = outputFileName({ directory: SHORT, besideSource: true, ...input });
  if (!result.ok) throw new Error(result.code);
  return result.fileName;
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cleaning a name for Windows', () => {
  it('removes characters Windows forbids, control characters included', () => {
    expect(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij');
    expect(sanitizeBaseName('tab\there\u0001\u001f!')).toBe('tabhere!');
  });

  it('removes trailing dots and spaces, and never leaves the name empty', () => {
    expect(sanitizeBaseName('name. . ')).toBe('name');
    expect(sanitizeBaseName('  leading stays')).toBe('  leading stays');
    expect(sanitizeBaseName('...')).toBe('_');
    expect(sanitizeBaseName('')).toBe('_');
    expect(sanitizeBaseName('???')).toBe('_');
  });

  it('removes every bidirectional control, so a name cannot pretend to another extension', () => {
    expect(sanitizeBaseName('invoice\u202egnp.exe')).toBe('invoicegnp.exe');
    expect(sanitizeBaseName('a\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069b')).toBe('ab');
  });

  it('prefixes reserved device names, whatever their case, trailing spaces or extension-like suffix', () => {
    for (const reserved of ['CON', 'con', 'Prn', 'AUX', 'NUL', 'COM0', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM¹', 'LPT³', 'CONIN$', 'conout$']) {
      expect(sanitizeBaseName(reserved)).toBe(`_${reserved}`);
    }
    expect(sanitizeBaseName('aux  ')).toBe('_aux');
    expect(sanitizeBaseName('nul.track1')).toBe('_nul.track1');
    expect(sanitizeBaseName('CON .track1')).toBe('_CON .track1');
    for (const ordinary of ['CONSOLE', 'COM10', 'LPT', 'my con', 'con-compressed', '日本語 タイトル 🎬']) expect(sanitizeBaseName(ordinary)).toBe(ordinary);
  });

  it('accepts only two- or three-letter lower-case languages', () => {
    for (const ok of ['en', 'eng', 'zho']) expect(isNameLanguage(ok)).toBe(true);
    for (const bad of ['', 'e', 'engl', 'ENG', 'en-us', 'e1', 'und ', null, undefined]) expect(isNameLanguage(bad)).toBe(false);
  });
});

describe('naming an output by task', () => {
  it('compress adds -compressed and takes the extension of its container', () => {
    expect(name({ sourceFileName: 'Holiday.MKV', baseName: { rule: 'compressed' }, extension: 'mp4' })).toBe('Holiday-compressed.mp4');
    expect(name({ sourceFileName: 'my.movie.final.mov', baseName: { rule: 'compressed' }, extension: 'mkv' })).toBe('my.movie.final-compressed.mkv');
    expect(name({ sourceFileName: path.join(SHORT, 'in', 'Clip.mov'), baseName: { rule: 'compressed' }, extension: 'mp4' })).toBe('Clip-compressed.mp4');
  });

  it('convert adds -converted only beside the source when the extension stays the same', () => {
    expect(name({ sourceFileName: 'clip.MP4', baseName: { rule: 'converted' }, extension: 'mp4' })).toBe('clip-converted.mp4');
    expect(name({ sourceFileName: 'clip.MP4', baseName: { rule: 'converted' }, extension: 'mp4', besideSource: false })).toBe('clip.mp4');
    expect(name({ sourceFileName: 'clip.mov', baseName: { rule: 'converted' }, extension: 'mp4' })).toBe('clip.mp4');
    expect(name({ sourceFileName: 'noextension', baseName: { rule: 'converted' }, extension: 'mkv' })).toBe('noextension.mkv');
  });

  it('extraction keeps the source name, or adds the track number and a valid language for all tracks', () => {
    expect(name({ sourceFileName: 'movie.final.mkv', baseName: { rule: 'source' }, extension: 'm4a' })).toBe('movie.final.m4a');
    // The Vorbis track of an Ogg video beside it would otherwise be named as the source itself.
    expect(name({ sourceFileName: 'theora.OGG', baseName: { rule: 'source' }, extension: 'ogg' })).toBe('theora-converted.ogg');
    expect(name({ sourceFileName: 'theora.ogg', baseName: { rule: 'source' }, extension: 'ogg', besideSource: false })).toBe('theora.ogg');
    expect(name({ sourceFileName: 'movie.mkv', baseName: { rule: 'track', number: 2, language: 'eng' }, extension: 'm4a' })).toBe('movie.track2.eng.m4a');
    expect(name({ sourceFileName: 'movie.mkv', baseName: { rule: 'track', number: 11, language: null }, extension: 'flac' })).toBe('movie.track11.flac');
    for (const language of ['en-us', 'ENG', 'e', 'engl', '../x']) {
      expect(name({ sourceFileName: 'movie.mkv', baseName: { rule: 'track', number: 1, language }, extension: 'mka' })).toBe('movie.track1.mka');
    }
  });

  it('cleans what comes from the source name', () => {
    expect(name({ sourceFileName: 'evil\u202ekcod.exe.mp4', baseName: { rule: 'compressed' }, extension: 'mp4' })).toBe('evilkcod.exe-compressed.mp4');
    expect(name({ sourceFileName: 'CON.mkv', baseName: { rule: 'converted' }, extension: 'mp4' })).toBe('_CON.mp4');
    expect(name({ sourceFileName: 'nul.mkv', baseName: { rule: 'track', number: 1, language: 'jpn' }, extension: 'm4a' })).toBe('_nul.track1.jpn.m4a');
    expect(name({ sourceFileName: 'trailing. .mkv', baseName: { rule: 'converted' }, extension: 'mp4' })).toBe('trailing.mp4');
    expect(name({ sourceFileName: '\u202e.mkv', baseName: { rule: 'converted' }, extension: 'mp4' })).toBe('_.mp4');
    expect(outputBaseName('Holiday.mkv', { rule: 'compressed' }, 'mp4', true)).toBe('Holiday-compressed');
  });
});

describe('fitting the folder', () => {
  const MAX = NAMING_POLICY.maxPathLength;
  const fileName = (input: Omit<OutputFileNameInput, 'besideSource'>) => outputFileName({ besideSource: false, ...input });

  it('keeps a name that fits exactly, and cuts the source part by one when one character over', () => {
    const directory = folder(MAX - 1 - 'x'.repeat(50).length - '.m4a'.length);
    expect(fileName({ directory, sourceFileName: `${'x'.repeat(50)}.mkv`, baseName: { rule: 'source' }, extension: 'm4a' }))
      .toEqual({ ok: true, fileName: `${'x'.repeat(50)}.m4a` });
    expect(fileName({ directory, sourceFileName: `${'x'.repeat(51)}.mkv`, baseName: { rule: 'source' }, extension: 'm4a' }))
      .toEqual({ ok: true, fileName: `${'x'.repeat(50)}.m4a` });
  });

  it('cuts only the source part: the task suffix and the extension stay', () => {
    const directory = folder(100);
    const result = fileName({ directory, sourceFileName: `${'x'.repeat(300)}.mkv`, baseName: { rule: 'compressed' }, extension: 'mp4' });
    expect(result.ok && result.fileName.endsWith('x-compressed.mp4')).toBe(true);
    expect(result.ok && path.join(directory, result.fileName)).toHaveLength(MAX);
    const track = fileName({ directory, sourceFileName: `${'y'.repeat(300)}.mkv`, baseName: { rule: 'track', number: 3, language: 'fra' }, extension: 'flac' });
    expect(track.ok && track.fileName.endsWith('y.track3.fra.flac')).toBe(true);
  });

  it('cuts at code points, never between the halves of a surrogate pair', () => {
    for (const length of [100, 101]) {
      const directory = folder(length);
      const result = fileName({ directory, sourceFileName: `${'😀'.repeat(150)}.mkv`, baseName: { rule: 'converted' }, extension: 'mp4' });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(LONE_SURROGATE.test(result.fileName)).toBe(false);
      expect(path.join(directory, result.fileName).length).toBeLessThanOrEqual(MAX);
      expect(path.join(directory, result.fileName).length).toBeGreaterThanOrEqual(MAX - 1);
    }
  });

  it('removes trailing dots and spaces that a cut leaves before the extension', () => {
    const directory = folder(MAX - 1 - 22 - '.m4a'.length);
    const result = fileName({ directory, sourceFileName: `${'a'.repeat(20)}. ${'b'.repeat(100)}.mkv`, baseName: { rule: 'source' }, extension: 'm4a' });
    expect(result).toEqual({ ok: true, fileName: `${'a'.repeat(20)}.m4a` });
  });

  it('refuses with output_path_too_long when the folder leaves less than 16 characters of a cut name', () => {
    const source = `${'a'.repeat(100)}.mkv`;
    const room = (stem: number) => folder(MAX - 1 - stem - '.m4a'.length);
    expect(fileName({ directory: room(16), sourceFileName: source, baseName: { rule: 'source' }, extension: 'm4a' })).toEqual({ ok: true, fileName: `${'a'.repeat(16)}.m4a` });
    expect(fileName({ directory: room(15), sourceFileName: source, baseName: { rule: 'source' }, extension: 'm4a' })).toEqual({ ok: false, code: 'output_path_too_long' });
    expect(fileName({ directory: folder(MAX - 2), sourceFileName: source, baseName: { rule: 'compressed' }, extension: 'mp4' })).toEqual({ ok: false, code: 'output_path_too_long' });
  });

  it('never refuses a short name that fits as it is', () => {
    const directory = folder(MAX - 1 - 'a.m4a'.length);
    expect(fileName({ directory, sourceFileName: 'a.mkv', baseName: { rule: 'source' }, extension: 'm4a' })).toEqual({ ok: true, fileName: 'a.m4a' });
  });
});
