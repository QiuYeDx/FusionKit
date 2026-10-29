import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversionSettingsSchema, outputSelectionSchema } from '@/media-converter/contract';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    },
  });
  return values;
});

const KEY = 'fusionkit.media-converter.preferences.v1';

async function loadStore() {
  vi.resetModules();
  return import('./useMediaConverterPreferences');
}

function persisted(): { version: number; state: Record<string, unknown> } {
  return JSON.parse(storage.get(KEY) ?? 'null');
}

beforeEach(() => {
  storage.clear();
});

describe('useMediaConverterPreferences', () => {
  it('starts from the defaults of AC-WORKBENCH-03-2/3/4', async () => {
    const { useMediaConverterPreferences } = await loadStore();
    expect(useMediaConverterPreferences.getState()).toMatchObject({
      task: 'compress',
      compress: { tier: 'balanced', codec: null, container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true },
      convert: { target: 'mp4', preferRemux: true, tier: 'balanced' },
      extract: { format: 'copy', tier: 'balanced', allTracks: false },
      output: { mode: 'source' },
      conflict: 'number',
    });
  });

  it('restores every preference after a reload, but never "overwrite"', async () => {
    const first = (await loadStore()).useMediaConverterPreferences.getState();
    first.setTask('extract-audio');
    first.setCompress({ tier: 'size', codec: 'av1', container: 'mkv', maxShortSide: 720, useGpuForAv1: true, discardIfNotSmaller: false });
    first.setConvert({ target: 'flac', preferRemux: false, tier: 'quality' });
    first.setExtract({ format: 'opus', tier: 'size', allTracks: true });
    first.setOutputDirectory({ id: 'dir_1', displayName: 'Exports' });
    first.setConflict('overwrite');
    expect(persisted().version).toBe(1);
    expect(persisted().state).not.toHaveProperty('conflict');
    expect(JSON.stringify(persisted())).not.toContain('overwrite');

    const second = (await loadStore()).useMediaConverterPreferences.getState();
    expect(second).toMatchObject({
      task: 'extract-audio',
      compress: { tier: 'size', codec: 'av1', container: 'mkv', maxShortSide: 720, useGpuForAv1: true, discardIfNotSmaller: false },
      convert: { target: 'flac', preferRemux: false, tier: 'quality' },
      extract: { format: 'opus', tier: 'size', allTracks: true },
      output: { mode: 'directory', directory: { id: 'dir_1', displayName: 'Exports' } },
      conflict: 'number',
    });
  });

  it('cleans invalid stored values field by field and drops what does not belong', async () => {
    storage.set(KEY, JSON.stringify({
      version: 1,
      state: {
        task: 'transcode',
        compress: { tier: 'size', codec: 'vp9', container: 'avi', maxShortSide: 1000, useGpuForAv1: 'yes', discardIfNotSmaller: false },
        convert: { target: 'exe', preferRemux: false, tier: 'quality', extra: 1 },
        extract: 'all',
        output: { mode: 'directory', directory: { id: '../../etc', displayName: 'x' } },
        conflict: 'overwrite',
        items: [{ id: 'a' }],
      },
    }));
    const state = (await loadStore()).useMediaConverterPreferences.getState();
    expect(state).toMatchObject({
      task: 'compress',
      compress: { tier: 'size', codec: null, container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: false },
      convert: { target: 'mp4', preferRemux: false, tier: 'quality' },
      extract: { format: 'copy', tier: 'balanced', allTracks: false },
      output: { mode: 'source' },
      conflict: 'number',
    });
    expect(state.convert).not.toHaveProperty('extra');
    expect(state).not.toHaveProperty('items');
    // The cleaned value is what is written back.
    state.setTask('convert');
    expect(persisted().state).toEqual({
      task: 'convert',
      compress: { tier: 'size', codec: null, container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: false },
      convert: { target: 'mp4', preferRemux: false, tier: 'quality' },
      extract: { format: 'copy', tier: 'balanced', allTracks: false },
      output: { mode: 'source' },
    });
  });

  it('survives unreadable storage and garbage', async () => {
    storage.set(KEY, '{not json');
    const { useMediaConverterPreferences, DEFAULT_MEDIA_CONVERTER_PREFERENCES, sanitizeMediaConverterPreferences } = await loadStore();
    expect(useMediaConverterPreferences.getState()).toMatchObject(DEFAULT_MEDIA_CONVERTER_PREFERENCES);
    for (const value of [null, 42, 'x', [], { compress: [] }]) expect(sanitizeMediaConverterPreferences(value)).toEqual(DEFAULT_MEDIA_CONVERTER_PREFERENCES);
    const failing = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => useMediaConverterPreferences.getState().setTask('convert')).not.toThrow();
    expect(useMediaConverterPreferences.getState().task).toBe('convert');
    failing.mockRestore();
  });

  it('rejects invalid values from the panel', async () => {
    const { useMediaConverterPreferences } = await loadStore();
    const state = useMediaConverterPreferences.getState();
    state.setCompress({ tier: 'extreme' as never, maxShortSide: 1080 });
    state.setTask('nothing' as never);
    state.setOutputDirectory({ id: 'a b', displayName: '' });
    state.setConflict('replace' as never);
    expect(useMediaConverterPreferences.getState()).toMatchObject({
      task: 'compress', compress: { tier: 'balanced', maxShortSide: 1080 }, output: { mode: 'source' }, conflict: 'number',
    });
  });

  it('follows the computer default codec until the user picks one, then keeps the pick', async () => {
    const { useMediaConverterPreferences, compressCodecOf, toConversionSettings } = await loadStore();
    const store = useMediaConverterPreferences;
    expect(compressCodecOf(store.getState(), 'h264')).toBe('h264');
    expect(compressCodecOf(store.getState(), 'hevc')).toBe('hevc');
    expect(toConversionSettings(store.getState(), { defaultCodec: 'hevc', av1HardwareAvailable: false })).toMatchObject({ task: 'compress', codec: 'hevc' });
    store.getState().setCompress({ codec: 'h264' });
    expect(compressCodecOf(store.getState(), 'hevc')).toBe('h264');
    const reloaded = (await loadStore()).useMediaConverterPreferences.getState();
    expect(reloaded.compress.codec).toBe('h264');
  });

  it('builds the settings the main process takes, with the GPU only for AV1 on an AV1 hardware encoder', async () => {
    const { useMediaConverterPreferences, toConversionSettings, toOutputSelection } = await loadStore();
    const store = useMediaConverterPreferences;
    store.getState().setCompress({ codec: 'av1', useGpuForAv1: true });
    const withGpu = toConversionSettings(store.getState(), { defaultCodec: 'h264', av1HardwareAvailable: true });
    expect(conversionSettingsSchema.parse(withGpu)).toEqual({ task: 'compress', tier: 'balanced', codec: 'av1', container: 'auto', maxShortSide: null, useGpuForAv1: true, discardIfNotSmaller: true });
    expect(toConversionSettings(store.getState(), { defaultCodec: 'h264', av1HardwareAvailable: false })).toMatchObject({ useGpuForAv1: false });
    store.getState().setCompress({ codec: 'hevc' });
    expect(toConversionSettings(store.getState(), { defaultCodec: 'h264', av1HardwareAvailable: true })).toMatchObject({ codec: 'hevc', useGpuForAv1: false });
    store.getState().setTask('convert');
    expect(conversionSettingsSchema.parse(toConversionSettings(store.getState(), { defaultCodec: 'h264', av1HardwareAvailable: true }))).toEqual({ task: 'convert', target: 'mp4', preferRemux: true, tier: 'balanced' });
    store.getState().setTask('extract-audio');
    expect(conversionSettingsSchema.parse(toConversionSettings(store.getState(), { defaultCodec: 'h264', av1HardwareAvailable: true }))).toEqual({ task: 'extract-audio', format: 'copy', tier: 'balanced', allTracks: false });

    expect(outputSelectionSchema.parse(toOutputSelection(store.getState()))).toEqual({ mode: 'source', conflict: 'number' });
    store.getState().setOutputDirectory({ id: 'dir_1', displayName: 'Exports' });
    store.getState().setConflict('overwrite');
    expect(outputSelectionSchema.parse(toOutputSelection(store.getState()))).toEqual({ mode: 'directory', directoryId: 'dir_1', conflict: 'overwrite' });
  });

  it('falls back to beside the source when the chosen folder is no longer known', async () => {
    const { useMediaConverterPreferences } = await loadStore();
    const store = useMediaConverterPreferences;
    expect(store.getState().reconcileOutputDirectories([])).toBe(false);
    store.getState().setOutputDirectory({ id: 'dir_1', displayName: 'Exports' });
    expect(store.getState().reconcileOutputDirectories([{ id: 'dir_1', displayName: 'Exports (renamed)' }, { id: 'dir_2', displayName: 'Other' }])).toBe(false);
    expect(store.getState().output).toEqual({ mode: 'directory', directory: { id: 'dir_1', displayName: 'Exports (renamed)' } });
    expect(store.getState().reconcileOutputDirectories([{ id: 'dir_2', displayName: 'Other' }])).toBe(true);
    expect(store.getState().output).toEqual({ mode: 'source' });
    // The fallback is saved: the next start does not try the vanished folder again.
    expect(persisted().state.output).toEqual({ mode: 'source' });
    expect(store.getState().reconcileOutputDirectories([])).toBe(false);
  });
});
