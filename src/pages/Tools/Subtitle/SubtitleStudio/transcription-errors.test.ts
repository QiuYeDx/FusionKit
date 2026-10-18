import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCodeSchema } from '@/subtitle-studio/domain';
import { LOCAL_SUBTITLE_ERROR_CODES } from '@/subtitle-studio/transcription/domain';
import { resourceErrorGuide, studioErrorDiagnostics, transcriptionTaskErrorGuide } from './transcription-errors';

const LANGUAGES = ['zh', 'zh-Hant', 'en', 'ja'] as const;
const catalogs = Object.fromEntries(LANGUAGES.map(language => [language, {
  studio: JSON.parse(readFileSync(path.resolve('src/locales', language, 'studio.json'), 'utf8')),
}])) as unknown as Record<(typeof LANGUAGES)[number], Record<string, unknown>>;
const lookup = (language: (typeof LANGUAGES)[number], key: string): unknown => {
  const [namespace, rest] = key.split(':') as [string, string];
  return rest.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalogs[language][namespace]);
};
const zh = (key: string) => lookup('zh', key) as string;

/** Codes a Studio transcription task can end with: the native runtime's and the Studio's own. */
const TASK_CODES = [...LOCAL_SUBTITLE_ERROR_CODES, ...errorCodeSchema.options];
/** Codes that never end a Studio transcription task: hand-off to the classic translator, cleanup, previews, empty results. */
const NOT_TASK_CODES = new Set(['configuration_not_ready', 'configuration_required', 'directory_authorization_required', 'profile_required',
  'profile_unavailable', 'duplicate', 'unsupported_format', 'import_failed', 'estimate_failed', 'start_rejected', 'cleanup_failed',
  'cancel_failed', 'cancelled_after_partial_commit', 'artifact_expired', 'artifact_changed', 'invalid_content', 'no_speech_detected',
  'invalid_input', 'unsupported_feature', 'encoding_required', 'revision_conflict', 'needs_configuration', 'knowledge_check_failed',
  'translation_protocol_invalid', 'translation_record_unavailable', 'translation_output_limit', 'translation_failed', 'invalid_pattern',
  'pattern_too_slow']);

describe('Studio transcription error guide', () => {
  it('gives every code a task can end with its own cause and next step, in plain words in all four languages', () => {
    for (const code of TASK_CODES) {
      const guide = transcriptionTaskErrorGuide(code, { vcRuntimeMissing: false });
      if (NOT_TASK_CODES.has(code)) continue;
      expect(guide.generic, code).toBe(false);
      expect(guide.nextKey, code).toBeDefined();
      for (const language of LANGUAGES) {
        const cause = lookup(language, guide.causeKey), next = lookup(language, guide.nextKey!);
        expect(typeof cause, `${language} ${code} ${guide.causeKey}`).toBe('string');
        expect(typeof next, `${language} ${code} ${guide.nextKey}`).toBe('string');
        // No error codes or developer words in what the user reads.
        expect(`${cause} ${next}`, `${language} ${code}`).not.toMatch(/[a-z]+_[a-z]+|Whisper|runtime|VAD|GGML/);
      }
    }
  });

  it('names the Studio controls that help: the resource manager, the device, the help page', () => {
    expect(transcriptionTaskErrorGuide('model_missing', { vcRuntimeMissing: false })).toMatchObject({ actions: ['open_resources'] });
    expect(zh(transcriptionTaskErrorGuide('model_missing', { vcRuntimeMissing: false }).nextKey!)).toContain('一键准备');
    const accelerator = transcriptionTaskErrorGuide('accelerator_unavailable', { vcRuntimeMissing: false });
    expect(accelerator).toMatchObject({ actions: ['open_resources', 'open_help'], helpSection: 'transcription-failed' });
    expect(zh(accelerator.nextKey!)).toContain('处理设备');
    expect(transcriptionTaskErrorGuide('unsupported_platform', { vcRuntimeMissing: false }).helpSection).toBe('system-requirements');
    expect(zh(transcriptionTaskErrorGuide('runtime_protocol_mismatch', { vcRuntimeMissing: false }).causeKey)).toContain('自带的转写程序');
    // The Studio's own codes: an interrupted task and a document that could not be saved.
    expect(zh(transcriptionTaskErrorGuide('interrupted', { vcRuntimeMissing: false }).causeKey)).toContain('中断');
    expect(zh(transcriptionTaskErrorGuide('document_unavailable', { vcRuntimeMissing: false }).causeKey)).toContain('没能保存');
  });

  it('says the VC++ runtime first when it is missing and could explain the failure', () => {
    for (const code of ['runtime_crashed', 'runtime_unresponsive', 'model_incompatible']) {
      expect(transcriptionTaskErrorGuide(code, { vcRuntimeMissing: true })).toEqual({ causeKey: 'studio:transcription.vc_runtime_failure', actions: ['open_help'], helpSection: 'transcription-failed', generic: false });
    }
    expect(transcriptionTaskErrorGuide('runtime_crashed', { vcRuntimeMissing: false }).causeKey).toBe('studio:transcription.task_error.crashed.cause');
    expect(transcriptionTaskErrorGuide('media_probe_failed', { vcRuntimeMissing: true }).causeKey).toBe('studio:transcription.task_error.media.cause');
  });

  it('keeps the generic words, and the diagnostics, for a code this version does not know', () => {
    for (const code of [undefined, 'something_new']) {
      expect(transcriptionTaskErrorGuide(code, { vcRuntimeMissing: false })).toEqual({
        causeKey: 'studio:transcription.task_failed', nextKey: 'studio:transcription.task_error.unknown.next', actions: [], generic: true });
    }
    expect(zh('studio:transcription.task_error.unknown.next')).toContain(zh('studio:transcription.copy_diagnostics'));
    expect(studioErrorDiagnostics({ code: 'something_new', model: 'large-v3-q5_0', device: 'cpu', stage: undefined, message: '' }))
      .toBe('code: something_new\nmodel: large-v3-q5_0\ndevice: cpu');
  });
});

describe('Studio resource error guide', () => {
  const download = { imported: false, vad: false, vcRuntimeMissing: false };
  it('explains the codes that used to fall back to "try again"', () => {
    expect(resourceErrorGuide('accelerator_unavailable', download)).toEqual({ key: 'studio:transcription.resource_failed_accelerator', network: false, help: 'transcription-failed', generic: false });
    expect(resourceErrorGuide('backend_unverified', download).key).toBe('studio:transcription.resource_failed_accelerator');
    expect(resourceErrorGuide('resource_busy', download).key).toBe('studio:transcription.shared_busy_error');
    expect(resourceErrorGuide('resource_busy', { ...download, imported: true }).key).toBe('studio:transcription.shared_busy_error');
    expect(resourceErrorGuide('resource_not_allowed', download).key).toBe('studio:transcription.resource_failed_not_allowed');
    expect(resourceErrorGuide('out_of_memory', download).key).toBe('studio:transcription.resource_failed_memory');
    expect(resourceErrorGuide('owner_released', download).key).toBe('studio:transcription.resource_failed_stale');
    expect(resourceErrorGuide('runtime_protocol_mismatch', download)).toMatchObject({ key: 'studio:transcription.resource_failed_runtime', help: 'transcription-failed' });
    // A crashed load check with the runtime in place: the file is there, the check failed.
    for (const code of ['runtime_crashed', 'runtime_unresponsive', 'model_incompatible']) {
      expect(resourceErrorGuide(code, download)).toMatchObject({ key: 'studio:transcription.resource_failed_load', help: 'transcription-failed' });
      expect(resourceErrorGuide(code, { ...download, vcRuntimeMissing: true }).key).toBe('studio:transcription.vc_runtime_failure');
    }
  });

  it('keeps the existing download, import, disk and voice-detection wording', () => {
    expect(resourceErrorGuide('model_download_failed', download)).toEqual({ key: 'studio:transcription.resource_failed_network', network: true, help: 'download-failed', generic: false });
    expect(resourceErrorGuide('model_corrupt', download)).toMatchObject({ key: 'studio:transcription.resource_failed_verify', network: true });
    expect(resourceErrorGuide('insufficient_disk', download).key).toBe('studio:transcription.resource_failed_disk');
    expect(resourceErrorGuide('model_missing', { ...download, vad: true }).key).toBe('studio:transcription.resource_failed_vad_needs_model');
    expect(resourceErrorGuide('model_corrupt', { ...download, imported: true }).key).toBe('studio:transcription.resource_import_mismatch');
    expect(resourceErrorGuide('model_incompatible', { ...download, imported: true, vcRuntimeMissing: true }).key).toBe('studio:transcription.resource_import_mismatch');
    expect(resourceErrorGuide('model_download_failed', { ...download, imported: true }).key).toBe('studio:transcription.resource_import_failed');
  });

  it('has every wording in all four languages, and the generic one only for unknown codes', () => {
    for (const code of LOCAL_SUBTITLE_ERROR_CODES) {
      for (const options of [download, { ...download, imported: true }, { ...download, vad: true }, { ...download, vcRuntimeMissing: true }]) {
        const guide = resourceErrorGuide(code, options);
        for (const language of LANGUAGES) expect(typeof lookup(language, guide.key), `${language} ${code} ${guide.key}`).toBe('string');
      }
    }
    expect(resourceErrorGuide('something_new', download)).toEqual({ key: 'studio:transcription.resource_failed', network: false, generic: true });
    expect(zh('studio:transcription.resource_failed')).toContain(zh('studio:transcription.copy_diagnostics'));
    expect(resourceErrorGuide('accelerator_unavailable', download).generic).toBe(false);
  });
});
