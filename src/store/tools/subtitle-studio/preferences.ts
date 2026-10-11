import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { encodingSchema, type Encoding } from '../../../subtitle-studio/domain';
import { CUE_AUDIO_PADDINGS, CUE_AUDIO_TEMPOS, DEFAULT_CUE_AUDIO_PADDING, type CueAudioPadding, type CueAudioTempo } from '../../../subtitle-studio/cue-audio';
import { DEFAULT_TRANSCRIPTION_PREFERENCES, readTranscriptionPreferences, transcriptionPreferencesSchema, type TranscriptionPreferences } from '../../../subtitle-studio/transcription/preferences-contract';

const readPadding = (value: unknown): CueAudioPadding => (CUE_AUDIO_PADDINGS as readonly unknown[]).includes(value) ? value as CueAudioPadding : DEFAULT_CUE_AUDIO_PADDING;
const readTempo = (value: unknown): CueAudioTempo => (CUE_AUDIO_TEMPOS as readonly unknown[]).includes(value) ? value as CueAudioTempo : 1;
export const useStudioPreferences = create<{ encoding: Encoding; dismissedRecoveryKey: string; transcription: TranscriptionPreferences;
  /** Original audio played before and after a cue, in milliseconds. */
  cueAudioPadMs: CueAudioPadding;
  /** Original audio playback speed and whether a played stretch repeats. */
  cueAudioTempo: CueAudioTempo; cueAudioLoop: boolean;
  setCueAudioTempo: (value: CueAudioTempo) => void; setCueAudioLoop: (value: boolean) => void;
  setEncoding: (value: Encoding) => void; dismissRecovery: (key: string) => void; setTranscription: (value: TranscriptionPreferences) => void; setCueAudioPadMs: (value: CueAudioPadding) => void }>()(persist(
  set => ({ encoding: 'utf-8', dismissedRecoveryKey: '', transcription: DEFAULT_TRANSCRIPTION_PREFERENCES, cueAudioPadMs: DEFAULT_CUE_AUDIO_PADDING, cueAudioTempo: 1, cueAudioLoop: false,
    setCueAudioTempo: value => set({ cueAudioTempo: readTempo(value) }), setCueAudioLoop: value => set({ cueAudioLoop: value === true }),
    setCueAudioPadMs: value => set({ cueAudioPadMs: readPadding(value) }),
    setEncoding: encoding => set({ encoding: encodingSchema.parse(encoding) }), dismissRecovery: dismissedRecoveryKey => set({ dismissedRecoveryKey }),
    setTranscription: value => set({ transcription: transcriptionPreferencesSchema.parse(value) }) }),
  {
    name: 'fusionkit.subtitle-studio.preferences.v1',
    version: 2,
    // Preference persistence must not interrupt file/capability or task operations.
    storage: createJSONStorage(() => ({
      getItem: name => { try { return globalThis.localStorage?.getItem(name) ?? null; } catch { return null; } },
      setItem: (name, value) => { try { globalThis.localStorage?.setItem(name, value); } catch { /* Keep the valid live preference. */ } },
      removeItem: name => { try { globalThis.localStorage?.removeItem(name); } catch { /* No task state is stored here. */ } },
    })),
    migrate: persisted => persisted,
    partialize: state => ({ encoding: state.encoding, dismissedRecoveryKey: state.dismissedRecoveryKey, transcription: state.transcription, cueAudioPadMs: state.cueAudioPadMs, cueAudioTempo: state.cueAudioTempo, cueAudioLoop: state.cueAudioLoop }),
    merge: (persisted, current) => {
      const value = persisted as { encoding?: unknown; dismissedRecoveryKey?: unknown; transcription?: unknown; cueAudioPadMs?: unknown; cueAudioTempo?: unknown; cueAudioLoop?: unknown } | undefined;
      return { ...current, encoding: encodingSchema.catch('utf-8').parse(value?.encoding), dismissedRecoveryKey: typeof value?.dismissedRecoveryKey === 'string' && value.dismissedRecoveryKey.length <= 200000 ? value.dismissedRecoveryKey : '',
        transcription: readTranscriptionPreferences(value?.transcription), cueAudioPadMs: readPadding(value?.cueAudioPadMs),
        cueAudioTempo: readTempo(value?.cueAudioTempo), cueAudioLoop: value?.cueAudioLoop === true };
    },
  },
));
