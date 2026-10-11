import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '../../../src/subtitle-studio/domain';
import { resolveCueAudioRange } from '../../../src/subtitle-studio/cue-audio';
import { CUE_RECOGNIZE_LIMITS, type CueRecognizeRequest, type CueRecognizeResult } from '../../../src/subtitle-studio/cue-recognize-contract';
import type { DocumentRepository } from './document-repository';
import type { CueMediaService } from './cue-media-service';
import type { CueAudioClipper } from './cue-audio-clip';
import type { RecognizeClipRequest } from './transcription/runtime';

export type CueRecognizeDependencies = {
  repository: DocumentRepository; media: CueMediaService; clipper: CueAudioClipper;
  /** Where the clip is written for the server, then removed. */
  workingDirectory: string;
  recognize: (request: RecognizeClipRequest) => Promise<Readonly<{ text: string; language: string }>>;
};

/**
 * Recognizes one cue again: its original audio (with a little on each side) is
 * decoded at 16 kHz into a private file, which the local transcription model reads;
 * the file is removed afterwards whatever happens.
 */
export async function recognizeCue(deps: CueRecognizeDependencies, owner: number, request: CueRecognizeRequest,
  guard: () => void = () => {}, signal?: AbortSignal): Promise<CueRecognizeResult> {
  const lane = `${owner}:recognize`;
  const ticket = deps.clipper.claim(lane);
  const abort = () => deps.clipper.cancel(lane);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const doc = (await deps.repository.readSnapshot(request.documentId)).document; guard();
    const range = resolveCueAudioRange(doc, { cueIds: [request.cueId] });
    if (range.truncated || range.endMs - range.startMs > CUE_RECOGNIZE_LIMITS.maxMs) throw new StudioError('limit_exceeded');
    const clipStartMs = Math.max(0, range.startMs - CUE_RECOGNIZE_LIMITS.padMs), clipEndMs = range.endMs + CUE_RECOGNIZE_LIMITS.padMs;
    const resolved = await deps.media.resolve(request.documentId, guard);
    if (!resolved.media) throw new StudioError('document_unavailable');
    const decoded = await deps.clipper.decode(lane, ticket, resolved.media.path, clipStartMs, clipEndMs, 1, CUE_RECOGNIZE_LIMITS.sampleRate); guard();
    if (signal?.aborted) throw new StudioError('interrupted');
    if (decoded.kind !== 'wav') throw new StudioError(decoded.reason === 'cancelled' ? 'interrupted' : 'transcription_failed');
    const file = path.join(deps.workingDirectory, `recognize-${randomUUID()}.wav`);
    try {
      await writeFile(file, decoded.bytes, { mode: 0o600, flag: 'wx' }); guard();
      const result = await deps.recognize({ modelId: request.modelId, devicePreference: request.devicePreference ?? 'auto', language: request.language,
        ...(request.initialPrompt ? { initialPrompt: request.initialPrompt } : {}), filePath: file, ...(signal ? { signal } : {}) });
      guard();
      return { text: result.text, ...(result.language ? { language: result.language } : {}) };
    } finally { await rm(file, { force: true }).catch(() => undefined); }
  } finally { signal?.removeEventListener('abort', abort); }
}
