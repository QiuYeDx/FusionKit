import { BrowserWindow, dialog, type WebContents } from 'electron';
import path from 'node:path';
import { StudioError, type ErrorCode } from '../../../src/subtitle-studio/domain';
import { requestSchemas, type TranscriptionMediaSelection, type TranscriptionResourceJob } from '../../../src/subtitle-studio/ipc-contract';
import { localSubtitleAuthorizedMediaSchema, localSubtitleMediaProbeSummarySchema, localSubtitleManagedResourceListSchema, localSubtitleResourceJobSummarySchema } from '../../../src/subtitle-studio/transcription/ipc-contract';
import type { LocalSubtitleOwnerKey } from './transcription/native/authorizations';
import type { TranscriptionRuntime } from './transcription/runtime';

export function transcriptionIpcError(error: unknown): ErrorCode {
  if (error instanceof StudioError) return error.code;
  const value = error && typeof error === 'object' ? error as { code?: unknown; localSubtitleCode?: unknown } : {};
  const code = value.localSubtitleCode ?? value.code;
  if (typeof code !== 'string') return 'transcription_failed';
  if (['owner_released', 'authorization_expired', 'authorization_invalid', 'invalid_token', 'token_expired', 'runtime_closed'].includes(code)) return 'access_denied';
  if (['limit_exceeded', 'queue_full', 'insufficient_disk'].includes(code)) return 'limit_exceeded';
  if (['invalid_configuration', 'invalid_input', 'invalid_ipc_request', 'resource_not_allowed'].includes(code)) return 'invalid_input';
  if (['unsupported_platform', 'unsupported_architecture', 'unsupported_format', 'unsupported_media'].includes(code)) return 'unsupported_feature';
  if (code.endsWith('_missing') || code.endsWith('_invalid') || ['not_initialized', 'runtime_protocol_mismatch'].includes(code)) return 'needs_configuration';
  if (['cancelled', 'aborted'].includes(code)) return 'interrupted';
  return 'transcription_failed';
}

function resourceJob(value: unknown): TranscriptionResourceJob {
  const { error, ...job } = localSubtitleResourceJobSummarySchema.parse(value);
  return { ...job, ...(error ? { error: { code: error.code } } : {}) };
}

/** Main-selected paths never become renderer inputs; every operation is owner-bound. */
export async function handleTranscriptionRequest(input: {
  method: string; payload: unknown; sender: WebContents; owner: LocalSubtitleOwnerKey;
  runtime: TranscriptionRuntime; alive: () => void;
}): Promise<unknown> {
  const { method, payload, sender, owner, runtime, alive } = input;
  alive();
  if (method === 'selectTranscriptionMedia') {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) throw new StudioError('access_denied');
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio / Video', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mkv', 'mov', 'webm', 'avi'] }] });
    alive();
    if (selection.canceled || !selection.filePaths.length) return null;
    const paths = [...new Set(selection.filePaths.map(file => path.resolve(file)))];
    if (paths.length > 20) throw new StudioError('limit_exceeded');
    const result: TranscriptionMediaSelection = { items: [] };
    for (const filePath of paths) {
      const displayName = path.basename(filePath).replace(/[\u0000-\u001f\u007f]/g, '\ufffd').slice(0, 256);
      let media: ReturnType<typeof localSubtitleAuthorizedMediaSchema.parse> | undefined;
      try {
        media = localSubtitleAuthorizedMediaSchema.parse(await runtime.media.authorizeInput(owner, filePath)); alive();
        const probe = localSubtitleMediaProbeSummarySchema.parse(await runtime.media.probe(owner, media.fileToken)); alive();
        result.items.push({ displayName, ok: true, media, probe });
      } catch (error) {
        alive();
        // Return any issued handle even when probing fails so the caller can retry or revoke it.
        result.items.push({ displayName, ok: false, error: transcriptionIpcError(error), ...(media ? { media } : {}) });
      }
    }
    return result;
  }
  if (method === 'probeTranscriptionMedia') {
    const { fileToken } = requestSchemas.probeTranscriptionMedia.parse(payload);
    const probe = localSubtitleMediaProbeSummarySchema.parse(await runtime.media.probe(owner, fileToken));
    alive();
    return probe;
  }
  if (method === 'revokeTranscriptionMedia') {
    const { fileToken } = requestSchemas.revokeTranscriptionMedia.parse(payload);
    return { revoked: await runtime.media.revokeInput(owner, fileToken) };
  }
  if (method === 'inspectTranscriptionRuntime') return runtime.inspectRuntime();
  if (method === 'listTranscriptionResources') {
    const resources = localSubtitleManagedResourceListSchema.parse(await runtime.resources.list(owner)); alive();
    return { resources, jobs: runtime.resources.snapshot(owner).resourceJobs.map(resourceJob) };
  }
  if (method === 'importTranscriptionModel') {
    const { modelId } = requestSchemas.importTranscriptionModel.parse(payload);
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) throw new StudioError('access_denied');
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'GGML', extensions: ['bin'] }] }); alive();
    if (selection.canceled || !selection.filePaths.length) return null;
    return resourceJob(await runtime.resources.importModel({ owner, filePath: selection.filePaths[0], modelId }));
  }
  if (method === 'installTranscriptionResource') return resourceJob(await runtime.resources.install(owner, requestSchemas.installTranscriptionResource.parse(payload).resourceId));
  if (method === 'cancelTranscriptionResourceJob') return runtime.resources.cancel(owner, requestSchemas.cancelTranscriptionResourceJob.parse(payload).jobId);
  if (method === 'enqueueTranscription') return runtime.tasks.enqueue(owner, requestSchemas.enqueueTranscription.parse(payload));
  if (method === 'listTranscriptionTasks') return runtime.tasks.list(owner);
  if (method === 'cancelTranscriptionTask') return runtime.tasks.cancel(owner, requestSchemas.cancelTranscriptionTask.parse(payload).taskId);
  if (method === 'removeTranscriptionTask') { await runtime.tasks.remove(owner, requestSchemas.removeTranscriptionTask.parse(payload).taskId); return null; }
  throw new StudioError('invalid_input');
}
