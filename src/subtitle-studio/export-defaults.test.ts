import { describe, expect, it } from 'vitest';
import { defaultBatchExportFormat, defaultExportFormat, isAudioMediaName } from './export-defaults';

const media = (displayName: string) => ({ format: 'media', displayName });

describe('default export format', () => {
  it('exports audio transcripts as LRC, video and unknown media as SRT, subtitles as themselves', () => {
    expect(defaultExportFormat(media('01.導入パート.WAV'))).toBe('lrc');
    expect(defaultExportFormat(media('track.flac'))).toBe('lrc');
    expect(defaultExportFormat(media('episode.mkv'))).toBe('srt');
    expect(defaultExportFormat(media('no-extension'))).toBe('srt');
    expect(defaultExportFormat({ format: 'vtt', displayName: 'a.vtt' })).toBe('vtt');
    expect(isAudioMediaName('song.mp3 ')).toBe(true);
  });
  it('uses LRC for a batch only when every document would', () => {
    expect(defaultBatchExportFormat([media('a.mp3'), media('b.m4a')])).toBe('lrc');
    expect(defaultBatchExportFormat([media('a.mp3'), media('b.mp4')])).toBe('srt');
    expect(defaultBatchExportFormat([])).toBe('srt');
  });
});
