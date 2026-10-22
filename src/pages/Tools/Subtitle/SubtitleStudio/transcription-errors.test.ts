import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCodeSchema } from '@/subtitle-studio/domain';
import { LOCAL_SUBTITLE_ERROR_CODES } from '@/subtitle-studio/transcription/domain';
import type { TranscriptionTaskSummary } from '@/subtitle-studio/transcription/task-contract';
import { resourceErrorGuide, studioErrorDiagnostics, transcriptionRetrySuggestion, transcriptionTaskDiagnostics, transcriptionTaskErrorGuide,
  transcriptionTaskRetryable } from './transcription-errors';

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

describe('Studio transcription failures by kind, retry and diagnostics', () => {
  const guide = (code: string, stage?: string) => transcriptionTaskErrorGuide(code, { vcRuntimeMissing: false, ...(stage ? { stage } : {}) });
  it('calls a window that failed to recognize a recognition quality problem, with what to change instead of a reinstall', () => {
    for (const [code, stage] of [['runtime_protocol_mismatch', 'transcribing'], ['runtime_protocol_mismatch', 'post_processing'],
      ['transcript_quality_failed', 'post_processing'], ['transcript_quality_failed', undefined]] as const) {
      expect(guide(code, stage), `${code} ${stage}`).toEqual({ causeKey: 'studio:transcription.task_error.quality.cause',
        nextKey: 'studio:transcription.task_error.quality.next', actions: [], generic: false });
    }
    const next = zh('studio:transcription.task_error.quality.next'), cause = zh('studio:transcription.task_error.quality.cause');
    for (const label of ['window_strategy', 'audio_type', 'model']) expect(next).toContain(zh(`studio:transcription.${label}`));
    expect(cause).toContain('识别质量'); expect(`${cause}${next}`).not.toContain('请重新安装');
    for (const language of LANGUAGES) expect(lookup(language, 'studio:transcription.task_error.quality.next'), language)
      .toContain(lookup(language, 'studio:transcription.window_strategy') as string);
    // The same code before anything was recognized is still the program: restart, then reinstall.
    for (const stage of ['loading_model', 'preflight', undefined]) {
      expect(guide('runtime_protocol_mismatch', stage).causeKey, String(stage)).toBe('studio:transcription.task_error.runtime.cause');
    }
    expect(zh(guide('runtime_protocol_mismatch', 'loading_model').nextKey!)).toContain('重新安装');
  });

  it('suggests a smaller model or the CPU when memory ran out', () => {
    const memory = guide('out_of_memory', 'loading_model');
    expect(memory).toMatchObject({ causeKey: 'studio:transcription.task_error.memory.cause', actions: ['open_resources'] });
    for (const name of ['resource_name_standard_short', 'resource_name_fast_short']) expect(zh(memory.nextKey!)).toContain(zh(`studio:transcription.${name}`));
    expect(zh(memory.nextKey!)).toContain('CPU');
  });

  const failure = (change: Partial<TranscriptionTaskSummary>): TranscriptionTaskSummary => ({ taskId: 'task-1', batchId: 'batch-1', generation: 1,
    displayName: 'Drama CD 03 - 第二話.flac', status: 'failed', progress: 37, createdAt: '2026-10-22T08:00:00.000Z', updatedAt: '2026-10-22T08:01:00.000Z',
    modelId: 'large-v3', resolvedBackend: 'cuda', error: { code: 'out_of_memory', stage: 'transcribing' }, ...change });
  const empty = (change: Partial<TranscriptionTaskSummary> = {}) => failure({ status: 'no_content', progress: 100, error: undefined, ...change });

  it('offers retry on failed and empty tasks, and the one suggestion that fits', () => {
    expect(transcriptionRetrySuggestion(empty())).toBe('quiet');
    expect(transcriptionRetrySuggestion(empty({ audioProfile: 'noisy_music_v1' }))).toBe('quiet');
    expect(transcriptionRetrySuggestion(empty({ audioProfile: 'quiet_whisper_v1' }))).toBeUndefined();
    // A failure the graphics card can cause, when it did not already run on the CPU.
    for (const code of ['out_of_memory', 'accelerator_unavailable', 'runtime_crashed', 'transcription_failed'] as const) {
      expect(transcriptionRetrySuggestion(failure({ error: { code } })), code).toBe('cpu');
      expect(transcriptionRetrySuggestion(failure({ error: { code }, resolvedBackend: 'cpu' })), code).toBeUndefined();
    }
    for (const code of ['runtime_protocol_mismatch', 'transcript_quality_failed', 'media_changed', 'model_missing'] as const) {
      expect(transcriptionRetrySuggestion(failure({ error: { code, stage: 'transcribing' } })), code).toBeUndefined();
    }
    expect([failure({}), empty()].map(transcriptionTaskRetryable)).toEqual([true, true]);
    // Nothing for a task that is still running, finished with a document, or still cleaning up.
    for (const task of [failure({ status: 'transcribing', error: undefined }), failure({ status: 'completed', error: undefined }),
      failure({ status: 'cancelled', error: undefined }), failure({ cleanupPending: true })]) {
      expect(transcriptionTaskRetryable(task), task.status).toBe(false); expect(transcriptionRetrySuggestion(task), task.status).toBeUndefined();
    }
  });

  it('copies the code, stage, model, device and audio type of every failure, and never the file', () => {
    const text = transcriptionTaskDiagnostics(failure({ error: { code: 'runtime_protocol_mismatch', stage: 'transcribing' }, audioProfile: 'quiet_whisper_v1' }));
    expect(text).toBe('code: runtime_protocol_mismatch\nstage: transcribing\nmodel: large-v3\ndevice: cuda\naudioType: quiet_whisper_v1');
    expect(transcriptionTaskDiagnostics(failure({ error: { code: 'interrupted' }, resolvedBackend: 'cpu' })))
      .toBe('code: interrupted\nmodel: large-v3\ndevice: cpu\naudioType: standard');
    for (const value of [text, transcriptionTaskDiagnostics(failure({}))]) {
      expect(value).not.toContain('Drama CD'); expect(value).not.toMatch(/[\\/]|\.flac|task-1|batch-1/);
    }
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
