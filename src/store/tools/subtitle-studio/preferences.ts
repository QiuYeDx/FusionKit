import { create } from 'zustand';
import { z } from 'zod';
import { persist, createJSONStorage } from 'zustand/middleware';
import { encodingSchema, type Encoding } from '../../../subtitle-studio/domain';
import { CUE_AUDIO_PADDINGS, CUE_AUDIO_TEMPOS, DEFAULT_CUE_AUDIO_PADDING, type CueAudioPadding, type CueAudioTempo } from '../../../subtitle-studio/cue-audio';
import { DEFAULT_TRANSCRIPTION_PREFERENCES, readTranscriptionPreferences, transcriptionPreferencesSchema, type TranscriptionPreferences } from '../../../subtitle-studio/transcription/preferences-contract';

const readPadding = (value: unknown): CueAudioPadding => (CUE_AUDIO_PADDINGS as readonly unknown[]).includes(value) ? value as CueAudioPadding : DEFAULT_CUE_AUDIO_PADDING;
const readTempo = (value: unknown): CueAudioTempo => (CUE_AUDIO_TEMPOS as readonly unknown[]).includes(value) ? value as CueAudioTempo : 1;
export const RECENT_KNOWLEDGE_SETS = 5;
const recentKnowledgeSetSchema = z.object({ languagePair: z.object({ source: z.string().min(1).max(80), target: z.string().min(1).max(80) }).strict(),
  collectionIds: z.array(z.string().uuid()).min(1).max(50), usedAt: z.number().int().nonnegative() }).strict();
export type RecentKnowledgeSet = z.infer<typeof recentKnowledgeSetSchema>;
const readRecentKnowledgeSets = (value: unknown): RecentKnowledgeSet[] => z.array(recentKnowledgeSetSchema).max(RECENT_KNOWLEDGE_SETS).catch([]).parse(value);
const sameSet = (a: Omit<RecentKnowledgeSet, 'usedAt'>, b: Omit<RecentKnowledgeSet, 'usedAt'>) => a.languagePair.source === b.languagePair.source && a.languagePair.target === b.languagePair.target
  && a.collectionIds.length === b.collectionIds.length && a.collectionIds.every(id => b.collectionIds.includes(id));
export const useStudioPreferences = create<{ encoding: Encoding; dismissedRecoveryKey: string; transcription: TranscriptionPreferences;
  /** Original audio played before and after a cue, in milliseconds. */
  cueAudioPadMs: CueAudioPadding;
  /** Original audio playback speed and whether a played stretch repeats. */
  cueAudioTempo: CueAudioTempo; cueAudioLoop: boolean;
  /** Collection combinations most recently used to translate, newest first. */
  recentKnowledgeSets: RecentKnowledgeSet[];
  rememberKnowledgeSet: (value: Omit<RecentKnowledgeSet, 'usedAt'>) => void;
  setCueAudioTempo: (value: CueAudioTempo) => void; setCueAudioLoop: (value: boolean) => void;
  setEncoding: (value: Encoding) => void; dismissRecovery: (key: string) => void; setTranscription: (value: TranscriptionPreferences) => void; setCueAudioPadMs: (value: CueAudioPadding) => void }>()(persist(
  set => ({ encoding: 'utf-8', dismissedRecoveryKey: '', transcription: DEFAULT_TRANSCRIPTION_PREFERENCES, cueAudioPadMs: DEFAULT_CUE_AUDIO_PADDING, cueAudioTempo: 1, cueAudioLoop: false, recentKnowledgeSets: [],
    rememberKnowledgeSet: value => set(state => {
      const next = recentKnowledgeSetSchema.safeParse({ ...value, collectionIds: [...new Set(value.collectionIds)], usedAt: Date.now() });
      if (!next.success) return {};
      return { recentKnowledgeSets: [next.data, ...state.recentKnowledgeSets.filter(item => !sameSet(item, next.data))].slice(0, RECENT_KNOWLEDGE_SETS) };
    }),
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
    partialize: state => ({ encoding: state.encoding, dismissedRecoveryKey: state.dismissedRecoveryKey, transcription: state.transcription, cueAudioPadMs: state.cueAudioPadMs, cueAudioTempo: state.cueAudioTempo, cueAudioLoop: state.cueAudioLoop, recentKnowledgeSets: state.recentKnowledgeSets }),
    merge: (persisted, current) => {
      const value = persisted as { encoding?: unknown; dismissedRecoveryKey?: unknown; transcription?: unknown; cueAudioPadMs?: unknown; cueAudioTempo?: unknown; cueAudioLoop?: unknown; recentKnowledgeSets?: unknown } | undefined;
      return { ...current, encoding: encodingSchema.catch('utf-8').parse(value?.encoding), dismissedRecoveryKey: typeof value?.dismissedRecoveryKey === 'string' && value.dismissedRecoveryKey.length <= 200000 ? value.dismissedRecoveryKey : '',
        transcription: readTranscriptionPreferences(value?.transcription), cueAudioPadMs: readPadding(value?.cueAudioPadMs),
        cueAudioTempo: readTempo(value?.cueAudioTempo), cueAudioLoop: value?.cueAudioLoop === true, recentKnowledgeSets: readRecentKnowledgeSets(value?.recentKnowledgeSets) };
    },
  },
));
