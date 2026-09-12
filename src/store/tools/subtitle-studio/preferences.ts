import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { encodingSchema, type Encoding } from '../../../subtitle-studio/domain';
import { DEFAULT_TRANSCRIPTION_PREFERENCES, readTranscriptionPreferences, transcriptionPreferencesSchema, type TranscriptionPreferences } from '../../../subtitle-studio/transcription/preferences-contract';

export const useStudioPreferences = create<{ encoding: Encoding; dismissedRecoveryKey: string; transcription: TranscriptionPreferences;
  setEncoding: (value: Encoding) => void; dismissRecovery: (key: string) => void; setTranscription: (value: TranscriptionPreferences) => void }>()(persist(
  set => ({ encoding: 'utf-8', dismissedRecoveryKey: '', transcription: DEFAULT_TRANSCRIPTION_PREFERENCES,
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
    partialize: state => ({ encoding: state.encoding, dismissedRecoveryKey: state.dismissedRecoveryKey, transcription: state.transcription }),
    merge: (persisted, current) => {
      const value = persisted as { encoding?: unknown; dismissedRecoveryKey?: unknown; transcription?: unknown } | undefined;
      return { ...current, encoding: encodingSchema.catch('utf-8').parse(value?.encoding), dismissedRecoveryKey: typeof value?.dismissedRecoveryKey === 'string' && value.dismissedRecoveryKey.length <= 200000 ? value.dismissedRecoveryKey : '',
        transcription: readTranscriptionPreferences(value?.transcription) };
    },
  },
));
