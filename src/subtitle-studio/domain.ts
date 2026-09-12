import { z } from 'zod';
import { localSubtitleTranscriptSchema } from './transcription/ipc-contract';

export const LIMITS = { inputBytes: 16 * 1024 * 1024, cues: 100000, nodes: 200000, cueBytes: 64 * 1024, snapshotBytes: 128 * 1024 * 1024, pageSize: 100 } as const;
export const idSchema = z.string().uuid();
export const encodingSchema = z.enum(['utf-8', 'gb18030', 'shift_jis', 'utf-16le']);
export const errorCodeSchema = z.enum(['invalid_input', 'unsupported_feature', 'encoding_required', 'limit_exceeded', 'revision_conflict', 'access_denied', 'document_unavailable', 'output_write_failed', 'needs_configuration', 'translation_protocol_invalid', 'translation_output_limit', 'translation_failed', 'interrupted']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export class StudioError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); }
}
const integer = z.number().int().safe();
const revision = integer.positive();
export const diagnosticSchema = z.object({
  code: z.enum(['empty_document', 'unsupported_markup', 'enhanced_lrc', 'negative_time', 'zero_duration', 'untimed_text']),
  nodeId: idSchema.optional(),
}).strict();
export type Diagnostic = z.infer<typeof diagnosticSchema>;
const spanSchema = z.object({ text: z.string(), marks: z.array(z.enum(['b', 'i', 'u'])).max(32) }).strict();
export const textSchema = z.object({ plain: z.string().max(LIMITS.cueBytes), spans: z.array(spanSchema).max(LIMITS.cueBytes) }).strict();
const importedRangeSchema = z.object({ nodeId: idSchema, start: integer.nonnegative(), end: integer.nonnegative() }).strict().refine(value => value.end > value.start);
export const textCueSchema = z.object({
  id: idSchema, sourceRevision: revision, timingRevision: revision,
  timing: z.object({ startMs: integer, endMs: integer.nullable(), provenance: z.enum(['srt', 'lrc_offset']) }).strict(),
  source: textSchema, sourceLabel: z.string().max(100).optional(), nodeId: idSchema,
  importedPair: z.object({ source: importedRangeSchema, target: importedRangeSchema }).strict().optional(),
}).strict().refine(cue => cue.timing.endMs === null || cue.timing.endMs >= cue.timing.startMs);
const textDocumentSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, revision,
  origin: z.object({ format: z.enum(['srt', 'lrc']), displayName: z.string().min(1).max(255), encoding: encodingSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  cues: z.array(textCueSchema).max(LIMITS.cues),
  translationTracks: z.array(z.object({
    id: idSchema, language: z.string().max(100), revision,
    origin: z.enum(['imported', 'ai', 'human']).optional(),
    entries: z.record(idSchema, z.object({ sourceRevision: revision, sourceHash: z.string(), text: textSchema, origin: z.enum(['ai', 'human', 'imported']), reviewStatus: z.enum(['unreviewed', 'reviewed']) }).strict()),
  }).strict()).max(100),
  bilingualImport: z.object({ sourceSide: z.enum(['first', 'second']), sourceLanguage: z.enum(['ja', 'zh', 'en', 'ko', 'und']), targetLanguage: z.enum(['ja', 'zh', 'en', 'ko', 'und']) }).strict().optional(),
  capabilities: z.object({ translate: z.boolean(), preserveSource: z.literal(true) }).strict(),
  diagnostics: z.array(diagnosticSchema).max(LIMITS.cues * 2 + 1),
  preservation: z.object({
    schemaVersion: z.literal(1), rawText: z.string().max(LIMITS.inputBytes), bom: z.boolean(), newline: z.enum(['lf', 'crlf', 'mixed']), offsetMs: integer,
    nodes: z.array(z.object({ id: idSchema, start: integer.nonnegative(), end: integer.nonnegative(), cueIds: z.array(idSchema).max(LIMITS.cues) }).strict()).max(LIMITS.nodes),
  }).strict(),
}).strict();
const mediaCueSchema = z.object({
  id: idSchema, sourceRevision: revision, timingRevision: revision,
  timing: z.object({ startMs: integer.nonnegative(), endMs: integer.positive(), provenance: z.literal('transcription') }).strict(),
  source: textSchema, segmentId: z.string().min(1).max(128),
  nodeId: z.never().optional(), sourceLabel: z.never().optional(), importedPair: z.never().optional(),
}).strict();
export const mediaDocumentSchema = z.object({
  schemaVersion: z.literal(2), id: idSchema, revision,
  origin: z.object({ format: z.literal('media'), displayName: z.string().min(1).max(255),
    durationMs: integer.positive(), transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  cues: z.array(mediaCueSchema).min(1).max(LIMITS.cues),
  translationTracks: textDocumentSchema.shape.translationTracks,
  bilingualImport: z.never().optional(),
  capabilities: z.object({ translate: z.boolean(), preserveSource: z.literal(false) }).strict(),
  diagnostics: textDocumentSchema.shape.diagnostics,
  preservation: z.object({ schemaVersion: z.literal(1), kind: z.literal('transcription'), transcript: localSubtitleTranscriptSchema }).strict(),
}).strict();
export const documentSchema = z.discriminatedUnion('schemaVersion', [textDocumentSchema, mediaDocumentSchema]);
export const cueSchema = z.union([textCueSchema, mediaCueSchema]);
export type SubtitleDocument = z.infer<typeof documentSchema>;
export type TextSubtitleDocument = z.infer<typeof textDocumentSchema>;
export type MediaSubtitleDocument = z.infer<typeof mediaDocumentSchema>;
export type TextSubtitleCue = z.infer<typeof textCueSchema>;
export type SubtitleCue = z.infer<typeof cueSchema>;
export type SubtitleText = z.infer<typeof textSchema>;
export type Encoding = z.infer<typeof encodingSchema>;

export function validateDocument(value: unknown): SubtitleDocument {
  const result = documentSchema.safeParse(value);
  if (!result.success) throw new StudioError('invalid_input');
  const doc = result.data;
  const ids = new Set(doc.cues.map(cue => cue.id));
  const cues = new Map<string, SubtitleCue>(doc.cues.map(cue => [cue.id, cue]));
  if (ids.size !== doc.cues.length) throw new StudioError('invalid_input');
  if (doc.schemaVersion === 2) {
    const transcript = doc.preservation.transcript;
    if (doc.origin.displayName !== transcript.source.displayName || doc.origin.durationMs !== transcript.source.durationMs
      || doc.cues.length !== transcript.segments.length || doc.diagnostics.length) throw new StudioError('invalid_input');
    doc.cues.forEach((cue, index) => {
      const segment = transcript.segments[index];
      if (cue.segmentId !== segment.id || cue.source.plain !== segment.text
        || cue.timing.startMs !== segment.startMs || cue.timing.endMs !== segment.endMs
        || cue.sourceRevision !== 1 || cue.timingRevision !== 1
        || cue.source.spans.length !== 1 || cue.source.spans[0].text !== segment.text || cue.source.spans[0].marks.length) {
        throw new StudioError('invalid_input');
      }
    });
  } else {
    const nodes = new Map(doc.preservation.nodes.map(node => [node.id, node]));
    const mapped = new Set<string>();
    const cueNodes = new Map<string, string>();
    if (nodes.size !== doc.preservation.nodes.length) throw new StudioError('invalid_input');
    let lastEnd = 0;
    for (const node of nodes.values()) {
      if (node.start !== lastEnd || node.end < node.start || node.end > doc.preservation.rawText.length) throw new StudioError('invalid_input');
      lastEnd = node.end;
      for (const id of node.cueIds) {
        if (!ids.has(id) || mapped.has(id)) throw new StudioError('invalid_input');
        mapped.add(id);
        cueNodes.set(id, node.id);
      }
    }
    if (lastEnd !== doc.preservation.rawText.length || mapped.size !== ids.size) throw new StudioError('invalid_input');
    for (const cue of doc.cues) {
      if (cueNodes.get(cue.id) !== cue.nodeId || new TextEncoder().encode(cue.source.plain).length > LIMITS.cueBytes || cue.source.spans.map(span => span.text).join('') !== cue.source.plain) throw new StudioError('invalid_input');
      if (cue.importedPair) {
        if (!doc.bilingualImport || cue.importedPair.source.nodeId !== cue.nodeId) throw new StudioError('invalid_input');
        for (const range of [cue.importedPair.source, cue.importedPair.target]) {
          const node = nodes.get(range.nodeId);
          if (!node || range.start < node.start || range.end > node.end) throw new StudioError('invalid_input');
        }
        const { source, target } = cue.importedPair;
        if (source.nodeId === target.nodeId && source.start < target.end && target.start < source.end) throw new StudioError('invalid_input');
      }
    }
  }
  for (const cue of doc.cues) {
    if (new TextEncoder().encode(cue.source.plain).length > LIMITS.cueBytes || cue.source.spans.map(span => span.text).join('') !== cue.source.plain) throw new StudioError('invalid_input');
  }
  const tracks = new Set<string>();
  if (doc.bilingualImport && !doc.cues.some(cue => cue.importedPair)) throw new StudioError('invalid_input');
  for (const track of doc.translationTracks) {
    if (tracks.has(track.id)) throw new StudioError('invalid_input');
    if (track.origin === 'imported' && !doc.bilingualImport) throw new StudioError('invalid_input');
    tracks.add(track.id);
    for (const [cueId, entry] of Object.entries(track.entries)) {
      if (!ids.has(cueId) || entry.text.spans.map(span => span.text).join('') !== entry.text.plain || new TextEncoder().encode(entry.text.plain).length > LIMITS.cueBytes) throw new StudioError('invalid_input');
      if (entry.origin === 'imported' && !cues.get(cueId)?.importedPair) throw new StudioError('invalid_input');
    }
  }
  return doc;
}
