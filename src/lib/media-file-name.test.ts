import { describe, expect, it } from 'vitest';
import { stripTrailingMediaExtension } from './media-file-name';
import { convertSubtitle } from '../../electron/main/conversion/converter';

describe('shared embedded media extension naming', () => {
  it.each(['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'ts', 'm2ts'])('strips %s case-insensitively using converter semantics', extension => {
    expect(stripTrailingMediaExtension(`Episode.01.${extension.toUpperCase()}`)).toBe('Episode.01');
    expect(convertSubtitle({ fileName: `Episode.01.${extension.toUpperCase()}.srt`, fileContent: '1\n00:00:01,000 --> 00:00:02,000\nHello\n', from: 'SRT', to: 'LRC', stripMediaExt: true }).outputFileName).toBe('Episode.01.lrc');
  });
  it.each(['Episode.01', 'file.wav.notes', '.wav', 'song.unknown'])('preserves unrelated names: %s', name => {
    expect(stripTrailingMediaExtension(name)).toBe(name);
  });
  it('removes only one embedded extension and keeps the converter opt-out', () => {
    expect(stripTrailingMediaExtension('song.wav.mp4')).toBe('song.wav');
    expect(convertSubtitle({ fileName: 'song.wav.srt', fileContent: '1\n00:00:01,000 --> 00:00:02,000\nHello\n', from: 'SRT', to: 'LRC', stripMediaExt: false }).outputFileName).toBe('song.wav.lrc');
  });
});
