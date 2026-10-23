import { describe, expect, it } from 'vitest';
import { SPEECH_MODEL_MANIFEST } from '../../electron/main/speech-resources/catalog';
import { fitTranscriptionConfig, transcriptionModelMismatch, transcriptionModelProfile, transcriptionModelSpeaks,
  type TranscriptionModelProfile } from '../../src/subtitle-studio/transcription-model-profiles';
import { DEFAULT_STUDIO_TRANSCRIPTION_CONFIG } from '../../src/subtitle-studio/transcription/preferences-contract';
import type { EnqueueTranscriptionRequest } from '../../src/subtitle-studio/transcription/task-contract';

type Config = EnqueueTranscriptionRequest['config'];
const config = (change: Partial<Omit<Config, 'advanced'>> & { advanced?: Partial<Config['advanced']> } = {}): Config =>
  ({ ...DEFAULT_STUDIO_TRANSCRIPTION_CONFIG, ...change, advanced: { ...DEFAULT_STUDIO_TRANSCRIPTION_CONFIG.advanced, ...change.advanced } });
const shape = (profile: TranscriptionModelProfile) => [profile.role, profile.languages, profile.translate, profile.prompt, profile.timestamps, profile.experimental];

describe('transcription model profiles', () => {
  it('describes every catalog model, in catalog order', () => {
    expect(SPEECH_MODEL_MANIFEST.models.map(model => [model.id, ...shape(transcriptionModelProfile(model.id))])).toEqual([
      ['large-v3-q5_0', 'transcribe', 'any', true, 'allow', 'model', false],
      ['large-v3', 'transcribe', 'any', true, 'allow', 'model', false],
      ['large-v3-turbo-q8_0', 'transcribe', 'any', false, 'allow', 'model', false],
      ['belle-large-v3-turbo-zh', 'recognize', ['zh'], false, 'allow', 'none', true],
      ['anime-whisper-q8_0', 'recognize', ['ja'], false, 'forbid', 'none', true],
    ]);
    expect(SPEECH_MODEL_MANIFEST.models.map(model => [transcriptionModelProfile(model.id).scenarioKey ?? null, transcriptionModelProfile(model.id).licenseKey ?? null])).toEqual([
      [null, null], [null, null], ['studio:transcription.model_scenario_fast', null],
      ['studio:transcription.model_scenario_chinese', 'studio:transcription.model_license_belle'],
      ['studio:transcription.model_scenario_anime', 'studio:transcription.model_license_anime'],
    ]);
  });

  it('lets a model this version does not know do whatever a whole-media model may', () => {
    for (const id of ['medium', 'constructor', '__proto__']) {
      expect(shape(transcriptionModelProfile(id))).toEqual(['transcribe', 'any', true, 'allow', 'model', false]);
      expect(transcriptionModelMismatch(config({ modelId: id, taskMode: 'translate_to_english', language: 'auto', advanced: { initialPrompt: 'Names' } }))).toBeNull();
    }
  });

  it('locks languages without automatic detection', () => {
    const chinese = transcriptionModelProfile('belle-large-v3-turbo-zh');
    expect(['zh', 'ja', 'auto'].map(language => transcriptionModelSpeaks(chinese, language))).toEqual([true, false, false]);
    expect(transcriptionModelSpeaks(transcriptionModelProfile('large-v3'), 'auto')).toBe(true);
  });

  it('finds the first unsupported choice, in the order the main process refuses them', () => {
    expect(transcriptionModelMismatch(config())).toBeNull();
    expect(transcriptionModelMismatch(config({ modelId: 'large-v3', taskMode: 'translate_to_english' }))).toBeNull();
    expect(transcriptionModelMismatch(config({ modelId: 'large-v3-turbo-q8_0', taskMode: 'translate_to_english' }))).toBe('translate');
    expect(transcriptionModelMismatch(config({ modelId: 'large-v3-turbo-q8_0', language: 'ko', advanced: { initialPrompt: 'Names' } }))).toBeNull();
    for (const modelId of ['belle-large-v3-turbo-zh', 'anime-whisper-q8_0']) {
      expect(transcriptionModelMismatch(fitTranscriptionConfig(config({ modelId })))).toBe('recognize_only');
    }
    // No whole-media model forbids hints or locks a language yet; the checks are general.
    const locked: TranscriptionModelProfile = { ...transcriptionModelProfile('large-v3'), languages: ['ja'], prompt: 'forbid' };
    expect(transcriptionModelMismatch(config({ language: 'ja', advanced: { initialPrompt: '' } }), locked)).toBe('prompt');
    expect(transcriptionModelMismatch(config({ language: 'auto' }), locked)).toBe('language');
    expect(transcriptionModelMismatch(config({ language: 'ja' }), locked)).toBeNull();
  });

  it('sets back only what the model cannot do and keeps everything else', () => {
    const translated = config({ modelId: 'large-v3', taskMode: 'translate_to_english', language: 'ja', advanced: { initialPrompt: 'Names' } });
    expect(fitTranscriptionConfig(translated)).toBe(translated);
    const fast = fitTranscriptionConfig({ ...translated, modelId: 'large-v3-turbo-q8_0' });
    expect(fast).toEqual({ ...translated, modelId: 'large-v3-turbo-q8_0', taskMode: 'transcribe' });
    const anime = fitTranscriptionConfig({ ...translated, modelId: 'anime-whisper-q8_0', language: 'auto' });
    expect(anime).toMatchObject({ modelId: 'anime-whisper-q8_0', taskMode: 'transcribe', language: 'ja', vadEnabled: true });
    expect(anime.advanced).toEqual(DEFAULT_STUDIO_TRANSCRIPTION_CONFIG.advanced);
    expect(fitTranscriptionConfig({ ...translated, modelId: 'belle-large-v3-turbo-zh' })).toMatchObject({ language: 'zh', advanced: { initialPrompt: 'Names' } });
  });
});
