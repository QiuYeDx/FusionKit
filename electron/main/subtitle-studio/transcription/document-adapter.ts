import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, StudioError, validateDocument, type MediaSubtitleDocument } from '../../../../src/subtitle-studio/domain';
import { localSubtitleTranscriptSchema } from '../../../../src/subtitle-studio/transcription/ipc-contract';
import { LOCAL_SUBTITLE_LIMITS } from '../../../../src/subtitle-studio/transcription/domain';

function assertSnapshotBudget(document: MediaSubtitleDocument) {
  let bytes = 0;
  const count = (value: unknown): void => {
    if (value === undefined) return;
    if (value !== null && typeof value === 'object') {
      const array = Array.isArray(value);
      const entries = array ? value.map(item => [null, item] as const) : Object.entries(value).filter(([, item]) => item !== undefined);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, item] of entries) {
        if (!array) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        count(item);
      }
    } else bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
  };
  count({ schemaVersion: 1, document, tasks: [] });
}

/** Canonical JSON from the strict transcript schema; this digest is not a media-file hash. */
export function transcriptToDocument(input: unknown, options: { documentId?: string; newId?: () => string } = {}): MediaSubtitleDocument {
  if (input && typeof input === 'object' && Array.isArray((input as { segments?: unknown }).segments)) {
    const segments = (input as { segments: Array<{ text?: unknown; words?: unknown }> }).segments;
    if (segments.length > LIMITS.cues) throw new StudioError('limit_exceeded');
    let words = 0;
    let minimumSnapshotBytes = 0;
    for (const segment of segments) {
      // Each source string occurs in preservation and in cue plain/spans. Reject obvious oversize before schema cloning.
      if (typeof segment?.text === 'string') minimumSnapshotBytes += 3 * Buffer.byteLength(JSON.stringify(segment.text));
      if (minimumSnapshotBytes > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
      if (Array.isArray(segment?.words)) {
        words += segment.words.length;
        if (segment.words.length > LOCAL_SUBTITLE_LIMITS.maxWordsPerSegment || words > LOCAL_SUBTITLE_LIMITS.maxTranscriptWords) throw new StudioError('limit_exceeded');
      }
    }
  }
  const parsed = localSubtitleTranscriptSchema.safeParse(input);
  if (!parsed.success) throw new StudioError('invalid_input');
  const transcript = parsed.data;
  const newId = options.newId ?? randomUUID;
  const document: MediaSubtitleDocument = {
    schemaVersion: 2, id: options.documentId ?? newId(), revision: 1,
    origin: { format: 'media', displayName: transcript.source.displayName, durationMs: transcript.source.durationMs,
      transcriptDigest: createHash('sha256').update(JSON.stringify(transcript)).digest('hex') },
    cues: transcript.segments.map(segment => ({
      id: newId(), sourceRevision: 1, timingRevision: 1, segmentId: segment.id,
      timing: { startMs: segment.startMs, endMs: segment.endMs, provenance: 'transcription' },
      source: { plain: segment.text, spans: [{ text: segment.text, marks: [] }] },
    })),
    translationTracks: [], capabilities: { translate: true, preserveSource: false }, diagnostics: [],
    preservation: { schemaVersion: 1, kind: 'transcription', transcript },
  };
  // Include the enclosing repository snapshot overhead in the same publication budget.
  assertSnapshotBudget(document);
  return validateDocument(document) as MediaSubtitleDocument;
}
