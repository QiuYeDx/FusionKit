import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';
import {
  compressCodecSchema,
  compressSettingsSchema,
  conversionTaskSchema,
  convertSettingsSchema,
  DEFAULT_CONVERT_SETTINGS,
  DEFAULT_EXTRACT_AUDIO_SETTINGS,
  extractAudioSettingsSchema,
  outputDirectorySchema,
  type CompressCodec,
  type CompressSettings,
  type ConversionSettings,
  type ConversionTask,
  type ConvertSettings,
  type ExtractAudioSettings,
  type OutputConflict,
  type OutputDirectory,
  type OutputSelection,
} from '@/media-converter/contract';

export const MEDIA_CONVERTER_PREFERENCES_KEY = 'fusionkit.media-converter.preferences.v1';
export const MEDIA_CONVERTER_PREFERENCES_VERSION = 1;

/**
 * "Compress video" as the panel shows it. `codec: null` follows the snapshot's
 * `defaults.compressCodec` (AC-ENCODE-02-7) until the user picks one, which is then remembered.
 */
export type CompressPreferences = Omit<CompressSettings, 'task' | 'codec'> & { codec: CompressCodec | null };
export type ConvertPreferences = Omit<ConvertSettings, 'task'>;
export type ExtractAudioPreferences = Omit<ExtractAudioSettings, 'task'>;
/** Where outputs go: beside the source, or a folder the main-process dialog returned (its id and the name shown). */
export type OutputPreference = { mode: 'source' } | { mode: 'directory'; directory: OutputDirectory };

/** What survives a restart (AC-WORKBENCH-03-4); low-usage mode and concurrency belong to the main process. */
export interface MediaConverterPreferences {
  task: ConversionTask;
  compress: CompressPreferences;
  convert: ConvertPreferences;
  extract: ExtractAudioPreferences;
  output: OutputPreference;
}

export interface MediaConverterPreferencesState extends MediaConverterPreferences {
  /** For this session only: "overwrite" is never saved, every start begins with numbering. */
  conflict: OutputConflict;
  setTask: (task: ConversionTask) => void;
  setCompress: (patch: Partial<CompressPreferences>) => void;
  setConvert: (patch: Partial<ConvertPreferences>) => void;
  setExtract: (patch: Partial<ExtractAudioPreferences>) => void;
  setOutputSource: () => void;
  setOutputDirectory: (directory: OutputDirectory) => void;
  setConflict: (conflict: OutputConflict) => void;
  /**
   * Checks the chosen folder against the folders the main process still knows. A folder it no
   * longer lists goes back to "beside the source"; returns true then, so the page can say so.
   */
  reconcileOutputDirectories: (directories: readonly OutputDirectory[]) => boolean;
}

const { task: _compressTask, codec: _compressCodec, ...compressShape } = compressSettingsSchema.shape;
const { task: _convertTask, ...convertShape } = convertSettingsSchema.shape;
const { task: _extractTask, ...extractShape } = extractAudioSettingsSchema.shape;

export const DEFAULT_MEDIA_CONVERTER_PREFERENCES: Readonly<MediaConverterPreferences> = Object.freeze({
  task: 'compress',
  compress: Object.freeze({ tier: 'balanced', codec: null, container: 'auto', maxShortSide: null, useGpuForAv1: false, discardIfNotSmaller: true }),
  convert: Object.freeze({ target: DEFAULT_CONVERT_SETTINGS.target, preferRemux: DEFAULT_CONVERT_SETTINGS.preferRemux, tier: DEFAULT_CONVERT_SETTINGS.tier }),
  extract: Object.freeze({ format: DEFAULT_EXTRACT_AUDIO_SETTINGS.format, tier: DEFAULT_EXTRACT_AUDIO_SETTINGS.tier, allTracks: DEFAULT_EXTRACT_AUDIO_SETTINGS.allTracks }),
  output: Object.freeze({ mode: 'source' }),
}) as MediaConverterPreferences;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every field of `shape` read on its own: an invalid one keeps its default, the others survive. */
function readFields<T extends Record<string, unknown>>(shape: Record<keyof T, z.ZodType>, value: unknown, fallback: T): T {
  const saved = isRecord(value) ? value : {};
  const result = {} as T;
  for (const key of Object.keys(fallback) as Array<keyof T>) {
    const parsed = shape[key].safeParse(saved[key as string]);
    result[key] = (parsed.success ? parsed.data : fallback[key]) as T[keyof T];
  }
  return result;
}

const compressFields = { ...compressShape, codec: compressCodecSchema.nullable() } as Record<keyof CompressPreferences, z.ZodType>;

function readOutput(value: unknown): OutputPreference {
  if (!isRecord(value) || value.mode !== 'directory') return { mode: 'source' };
  const directory = outputDirectorySchema.safeParse(value.directory);
  return directory.success ? { mode: 'directory', directory: directory.data } : { mode: 'source' };
}

/** The saved preferences of any stored value: zod-checked field by field, never the conflict policy. */
export function sanitizeMediaConverterPreferences(value: unknown): MediaConverterPreferences {
  const saved = isRecord(value) ? value : {};
  const fallback = DEFAULT_MEDIA_CONVERTER_PREFERENCES;
  const task = conversionTaskSchema.safeParse(saved.task);
  return {
    task: task.success ? task.data : fallback.task,
    compress: readFields(compressFields, saved.compress, { ...fallback.compress }),
    convert: readFields(convertShape as Record<keyof ConvertPreferences, z.ZodType>, saved.convert, { ...fallback.convert }),
    extract: readFields(extractShape as Record<keyof ExtractAudioPreferences, z.ZodType>, saved.extract, { ...fallback.extract }),
    output: readOutput(saved.output),
  };
}

/** The codec "compress video" uses: the user's pick, else this computer's default. */
export const compressCodecOf = (preferences: Pick<MediaConverterPreferences, 'compress'>, defaultCodec: CompressCodec): CompressCodec =>
  preferences.compress.codec ?? defaultCodec;

export interface SettingsContext {
  /** `defaults.compressCodec` of the snapshot. */
  defaultCodec: CompressCodec;
  /** An AV1 hardware encoder works (`resolvedEncoders.av1.gpuOn.hardware`): only then can "use the graphics card" be on. */
  av1HardwareAvailable: boolean;
}

/** The settings a start or a plan preview sends for the selected task. */
export function toConversionSettings(preferences: MediaConverterPreferences, context: SettingsContext): ConversionSettings {
  switch (preferences.task) {
    case 'compress': {
      const codec = compressCodecOf(preferences, context.defaultCodec);
      const { codec: _codec, ...compress } = preferences.compress;
      return { task: 'compress', ...compress, codec, useGpuForAv1: codec === 'av1' && context.av1HardwareAvailable && compress.useGpuForAv1 };
    }
    case 'convert':
      return { task: 'convert', ...preferences.convert };
    case 'extract-audio':
      return { task: 'extract-audio', ...preferences.extract };
  }
}

/** Where a start writes its outputs. */
export function toOutputSelection(state: Pick<MediaConverterPreferencesState, 'output' | 'conflict'>): OutputSelection {
  return state.output.mode === 'directory'
    ? { mode: 'directory', directoryId: state.output.directory.id, conflict: state.conflict }
    : { mode: 'source', conflict: state.conflict };
}

const patched = <T extends object>(fields: Record<keyof T, z.ZodType>, current: T, patch: Partial<T>): T =>
  readFields(fields as Record<string, z.ZodType>, { ...current, ...patch }, current as Record<string, unknown>) as T;

/**
 * Interface preferences of the media converter (module-workbench design 渲染进程架构). The queue,
 * its options and the folders it knows live in the main process; this keeps what the panel shows.
 */
export const useMediaConverterPreferences = create<MediaConverterPreferencesState>()(persist(
  (set, get) => ({
    ...DEFAULT_MEDIA_CONVERTER_PREFERENCES,
    conflict: 'number',
    setTask: task => { if (conversionTaskSchema.safeParse(task).success) set({ task }); },
    setCompress: patch => set(state => ({ compress: patched(compressFields, state.compress, patch) })),
    setConvert: patch => set(state => ({ convert: patched(convertShape as Record<keyof ConvertPreferences, z.ZodType>, state.convert, patch) })),
    setExtract: patch => set(state => ({ extract: patched(extractShape as Record<keyof ExtractAudioPreferences, z.ZodType>, state.extract, patch) })),
    setOutputSource: () => set({ output: { mode: 'source' } }),
    setOutputDirectory: directory => {
      const parsed = outputDirectorySchema.safeParse(directory);
      if (parsed.success) set({ output: { mode: 'directory', directory: parsed.data } });
    },
    setConflict: conflict => set({ conflict: conflict === 'overwrite' ? 'overwrite' : 'number' }),
    reconcileOutputDirectories: directories => {
      const output = get().output;
      if (output.mode !== 'directory') return false;
      const known = directories.find(directory => directory.id === output.directory.id);
      if (!known) {
        set({ output: { mode: 'source' } });
        return true;
      }
      if (known.displayName !== output.directory.displayName) set({ output: { mode: 'directory', directory: { ...known } } });
      return false;
    },
  }),
  {
    name: MEDIA_CONVERTER_PREFERENCES_KEY,
    version: MEDIA_CONVERTER_PREFERENCES_VERSION,
    // Preferences never interrupt the queue: storage that fails keeps the live choice.
    storage: createJSONStorage(() => ({
      getItem: name => { try { return globalThis.localStorage?.getItem(name) ?? null; } catch { return null; } },
      setItem: (name, value) => { try { globalThis.localStorage?.setItem(name, value); } catch { /* The live preference stays valid. */ } },
      removeItem: name => { try { globalThis.localStorage?.removeItem(name); } catch { /* Nothing else is stored here. */ } },
    })),
    partialize: state => sanitizeMediaConverterPreferences(state),
    migrate: persisted => sanitizeMediaConverterPreferences(persisted),
    merge: (persisted, current) => ({ ...current, ...sanitizeMediaConverterPreferences(persisted), conflict: 'number' }),
  },
));
