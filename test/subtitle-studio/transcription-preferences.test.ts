import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATIC_KNOWLEDGE, DEFAULT_TRANSCRIPTION_PREFERENCES, readTranscriptionPreferences, transcriptionPreferencesSchema } from '../../src/subtitle-studio/transcription/preferences-contract';
import { useStudioPreferences } from '../../src/store/tools/subtitle-studio/preferences';

afterEach(() => { vi.unstubAllGlobals(); useStudioPreferences.setState({ encoding: 'utf-8', dismissedRecoveryKey: '', transcription: structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES), recentKnowledgeSets: [] }); });
it('defaults automatic translation off and rejects unknown credentials or inconsistent acoustic settings', () => {
  expect(readTranscriptionPreferences(undefined)).toEqual(DEFAULT_TRANSCRIPTION_PREFERENCES);
  expect(DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation.enabled).toBe(false);
  expect(transcriptionPreferencesSchema.safeParse({ ...DEFAULT_TRANSCRIPTION_PREFERENCES, apiKey: 'secret' }).success).toBe(false);
  expect(transcriptionPreferencesSchema.safeParse({ ...DEFAULT_TRANSCRIPTION_PREFERENCES, config: { ...DEFAULT_TRANSCRIPTION_PREFERENCES.config, vadEnabled: false } }).success).toBe(false);
  expect(readTranscriptionPreferences({ ...DEFAULT_TRANSCRIPTION_PREFERENCES, autoTranslation: { ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, fileToken: 'no' } })).toEqual(DEFAULT_TRANSCRIPTION_PREFERENCES);
});
it('hydrates the existing preference key and persists only valid settings alongside existing preferences', async () => {
  const storage = new Map<string, string>();
  const key = 'fusionkit.subtitle-studio.preferences.v1';
  storage.set(key, JSON.stringify({ version: 0, state: { encoding: 'gb18030', dismissedRecoveryKey: 'acknowledged' } }));
  vi.stubGlobal('localStorage', { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) });
  await useStudioPreferences.persist.rehydrate();
  expect(useStudioPreferences.getState().encoding).toBe('gb18030'); expect(useStudioPreferences.getState().dismissedRecoveryKey).toBe('acknowledged');
  const settings = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES); settings.config.language = 'ja'; settings.config.advanced.beamSize = 7; settings.autoTranslation.enabled = true; settings.autoTranslation.profileId = 'profile';
  useStudioPreferences.getState().setTranscription(settings);
  const persisted = JSON.parse(storage.get(key)!);
  expect(Object.keys(persisted.state).sort()).toEqual(['cueAudioLoop', 'cueAudioPadMs', 'cueAudioTempo', 'dismissedRecoveryKey', 'encoding', 'recentKnowledgeSets', 'transcription']);
  // An older store without the original-audio padding gets the default.
  expect(persisted.state.cueAudioPadMs).toBe(300);
  expect(persisted.state.cueAudioTempo).toBe(1); expect(persisted.state.cueAudioLoop).toBe(false);
  expect(persisted.state.transcription).toEqual(settings);
  useStudioPreferences.setState({ transcription: structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES) });
  storage.set(key, JSON.stringify(persisted)); await useStudioPreferences.persist.rehydrate();
  expect(useStudioPreferences.getState().transcription).toEqual(settings);
});
it('keeps the valid live choice when local storage is unavailable and falls back from corruption', async () => {
  vi.stubGlobal('localStorage', { getItem: () => '{broken', setItem: () => { throw new Error('quota'); }, removeItem: () => {} });
  await useStudioPreferences.persist.rehydrate();
  const next = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES); next.config.language = 'en';
  expect(() => useStudioPreferences.getState().setTranscription(next)).not.toThrow(); expect(useStudioPreferences.getState().transcription).toEqual(next);
});
it('persists the audio type inside the transcription settings and refuses a profile without voice detection', async () => {
  const storage = new Map<string, string>();
  const key = 'fusionkit.subtitle-studio.preferences.v1';
  vi.stubGlobal('localStorage', { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) });
  await useStudioPreferences.persist.rehydrate();
  expect(DEFAULT_TRANSCRIPTION_PREFERENCES.config.advanced).not.toHaveProperty('audioProfile');
  const settings = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES);
  settings.config = { ...settings.config, advanced: { ...settings.config.advanced, audioProfile: 'quiet_whisper_v1' } };
  useStudioPreferences.getState().setTranscription(settings);
  const persisted = JSON.parse(storage.get(key)!);
  expect(Object.keys(persisted.state).sort()).toEqual(['cueAudioLoop', 'cueAudioPadMs', 'cueAudioTempo', 'dismissedRecoveryKey', 'encoding', 'recentKnowledgeSets', 'transcription']);
  expect(persisted.state.transcription.config.advanced.audioProfile).toBe('quiet_whisper_v1');
  useStudioPreferences.setState({ transcription: structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES) });
  storage.set(key, JSON.stringify(persisted)); await useStudioPreferences.persist.rehydrate();
  expect(useStudioPreferences.getState().transcription).toEqual(settings);
  expect(readTranscriptionPreferences(useStudioPreferences.getState().transcription)).toEqual(settings);
  const offWithProfile = { ...settings, config: { ...settings.config, vadEnabled: false, windowStrategy: 'fixed_v1' as const } };
  expect(transcriptionPreferencesSchema.safeParse(offWithProfile).success).toBe(false);
  expect(transcriptionPreferencesSchema.safeParse({ ...settings, config: { ...settings.config, advanced: { ...settings.config.advanced, audioProfile: 'loud_v1' } } }).success).toBe(false);
});
it('reads older transcription settings without resetting ASR or automatic model preferences', () => {
  const saved = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES);
  saved.config.language = 'ja'; saved.config.advanced.beamSize = 7;
  saved.autoTranslation = { ...saved.autoTranslation, enabled: true, profileId: 'saved-profile', language: 'en' };
  expect(readTranscriptionPreferences(saved)).toEqual(saved);
  expect(readTranscriptionPreferences(saved).autoTranslation).not.toHaveProperty('knowledge');
});
it('persists only shared automatic knowledge choices, including explicitly cleared instructions', () => {
  const knowledge = { ...DEFAULT_AUTOMATIC_KNOWLEDGE, enabled: true, sourceLanguage: 'ja', instructions: '', context: 'Shared episode background',
    collectionIds: ['11111111-1111-4111-8111-111111111111'], disabledEntryIds: ['33333333-3333-4333-8333-333333333333'] };
  const saved = { ...DEFAULT_TRANSCRIPTION_PREFERENCES, autoTranslation: { ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, knowledge } };
  expect(readTranscriptionPreferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  for (const extra of [{ knowledgeGeneration: 12 }, { apiKey: 'secret' }, { snapshot: {} }, { bindings: [] }, { confirmations: [] }, { targetLanguage: 'en' }]) {
    expect(transcriptionPreferencesSchema.safeParse({ ...saved, autoTranslation: { ...saved.autoTranslation, knowledge: { ...knowledge, ...extra } } }).success).toBe(false);
  }
  expect(transcriptionPreferencesSchema.safeParse({ ...saved, autoTranslation: { ...saved.autoTranslation, knowledge: { ...knowledge, sourceLanguage: 'auto' } } }).success).toBe(false);
  for (const duplicate of [{ collectionIds: [knowledge.collectionIds[0], knowledge.collectionIds[0]] }, { disabledEntryIds: [knowledge.disabledEntryIds[0], knowledge.disabledEntryIds[0]] }]) {
    expect(transcriptionPreferencesSchema.safeParse({ ...saved, autoTranslation: { ...saved.autoTranslation, knowledge: { ...knowledge, ...duplicate } } }).success).toBe(false);
  }
});
it('falls back to defaults for earlier automatic knowledge choices instead of migrating removed recipe or topic fields', () => {
  const knowledge = { ...DEFAULT_AUTOMATIC_KNOWLEDGE, enabled: true, sourceLanguage: 'ja', collectionIds: ['11111111-1111-4111-8111-111111111111'] };
  for (const removed of [{ recipeId: '44444444-4444-4444-8444-444444444444' }, { documentTopicIds: ['22222222-2222-4222-8222-222222222222'] }]) {
    const saved = { ...DEFAULT_TRANSCRIPTION_PREFERENCES, autoTranslation: { ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, enabled: true, knowledge: { ...knowledge, ...removed } } };
    expect(readTranscriptionPreferences(JSON.parse(JSON.stringify(saved)))).toEqual(DEFAULT_TRANSCRIPTION_PREFERENCES);
  }
});

it('remembers the five most recent distinct collection combinations, newest first', async () => {
  const pair = { source: 'en', target: 'zh-Hans' };
  const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const { rememberKnowledgeSet } = useStudioPreferences.getState();
  for (let n = 1; n <= 6; n++) rememberKnowledgeSet({ languagePair: pair, collectionIds: [id(n)] });
  rememberKnowledgeSet({ languagePair: pair, collectionIds: [id(3)] });
  rememberKnowledgeSet({ languagePair: pair, collectionIds: [id(9), id(9)] });
  rememberKnowledgeSet({ languagePair: pair, collectionIds: [] });
  const recent = useStudioPreferences.getState().recentKnowledgeSets;
  expect(recent.map(item => item.collectionIds)).toEqual([[id(9)], [id(3)], [id(6)], [id(5)], [id(4)]]);
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ state: { recentKnowledgeSets: [{ languagePair: pair, collectionIds: ['not-a-uuid'], usedAt: 1 }] }, version: 2 }), setItem: () => {}, removeItem: () => {} });
  await useStudioPreferences.persist.rehydrate();
  expect(useStudioPreferences.getState().recentKnowledgeSets).toEqual([]);
});
