import { describe, expect, it } from 'vitest';
import { subtitleExportFileName } from '../../src/subtitle-studio/export-filename';
import { exportOptionsSchema, type ExportOptions } from '../../src/subtitle-studio/export-contract';
const options: ExportOptions = { mode: 'source', format: 'srt', order: 'source-first', encoding: 'utf-8', bom: false, newline: 'lf', incomplete: 'source-fallback', missingEnd: { mode: 'block' } };
const doc = (displayName: string) => ({ origin: { displayName }, translationTracks: [] });

describe('studio media extension export option', () => {
  it.each(['srt', 'lrc', 'vtt', 'ass'] as const)('defaults to stripping before %s and preserves an explicit opt-out', format => {
    expect(subtitleExportFileName(doc('episode.MP4.srt'), { ...options, format })).toBe(`episode.${format}`);
    expect(subtitleExportFileName(doc('episode.MP4.srt'), { ...options, format, stripMediaExt: true })).toBe(`episode.${format}`);
    expect(subtitleExportFileName(doc('episode.MP4.srt'), { ...options, format, stripMediaExt: false })).toBe(`episode.MP4.${format}`);
  });
  it('composes with custom suffixes, filename safety and media-origin documents', () => {
    expect(subtitleExportFileName(doc('lecture.wav.vtt'), { ...options, fileNameSuffix: { mode: 'custom', value: 'final' } })).toBe('lecture.final.srt');
    expect(subtitleExportFileName(doc('CON.wav.ass'), options)).toBe('_CON.srt');
    expect(subtitleExportFileName(doc('lecture.wav'), options)).toBe('lecture.srt');
    expect(subtitleExportFileName(doc('episode.01.srt'), options)).toBe('episode.01.srt');
  });
  it('accepts legacy options and rejects non-boolean switch values', () => {
    expect(exportOptionsSchema.safeParse(options).success).toBe(true);
    expect(exportOptionsSchema.safeParse({ ...options, stripMediaExt: 'false' }).success).toBe(false);
  });
});
