import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATIC_KNOWLEDGE, DEFAULT_TRANSCRIPTION_PREFERENCES, readTranscriptionPreferences, transcriptionPreferencesSchema } from '../../src/subtitle-studio/transcription/preferences-contract';
import { useStudioPreferences } from '../../src/store/tools/subtitle-studio/preferences';

afterEach(() => { vi.unstubAllGlobals(); useStudioPreferences.setState({ encoding: 'utf-8', dismissedRecoveryKey: '', transcription: structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES) }); });
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
  expect(Object.keys(persisted.state).sort()).toEqual(['dismissedRecoveryKey', 'encoding', 'transcription']);
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
it('reads older transcription settings without resetting ASR or automatic model preferences', () => {
  const saved = structuredClone(DEFAULT_TRANSCRIPTION_PREFERENCES);
  saved.config.language = 'ja'; saved.config.advanced.beamSize = 7;
  saved.autoTranslation = { ...saved.autoTranslation, enabled: true, profileId: 'saved-profile', language: 'en' };
  expect(readTranscriptionPreferences(saved)).toEqual(saved);
  expect(readTranscriptionPreferences(saved).autoTranslation).not.toHaveProperty('knowledge');
});
it('persists only shared automatic knowledge choices, including explicitly cleared recipe defaults', () => {
  const knowledge = { ...DEFAULT_AUTOMATIC_KNOWLEDGE, enabled: true, sourceLanguage: 'ja', instructions: '', context: 'Shared episode background',
    collectionIds: ['11111111-1111-4111-8111-111111111111'], documentTopicIds: ['22222222-2222-4222-8222-222222222222'] };
  const saved = { ...DEFAULT_TRANSCRIPTION_PREFERENCES, autoTranslation: { ...DEFAULT_TRANSCRIPTION_PREFERENCES.autoTranslation, knowledge } };
  expect(readTranscriptionPreferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  for (const extra of [{ knowledgeGeneration: 12 }, { apiKey: 'secret' }, { snapshot: {} }, { bindings: [] }, { confirmations: [] }, { targetLanguage: 'en' }]) {
    expect(transcriptionPreferencesSchema.safeParse({ ...saved, autoTranslation: { ...saved.autoTranslation, knowledge: { ...knowledge, ...extra } } }).success).toBe(false);
  }
  expect(transcriptionPreferencesSchema.safeParse({ ...saved, autoTranslation: { ...saved.autoTranslation, knowledge: { ...knowledge, sourceLanguage: 'auto' } } }).success).toBe(false);
});
