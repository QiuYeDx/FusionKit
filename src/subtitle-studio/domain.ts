import { z } from 'zod';

export const LIMITS = { inputBytes: 16 * 1024 * 1024, cues: 100000, nodes: 200000, cueBytes: 64 * 1024, snapshotBytes: 128 * 1024 * 1024, pageSize: 100 } as const;
export const idSchema = z.string().uuid();
export const encodingSchema = z.enum(['utf-8', 'gb18030', 'shift_jis', 'utf-16le']);
export const errorCodeSchema = z.enum(['invalid_input', 'unsupported_feature', 'encoding_required', 'limit_exceeded', 'revision_conflict', 'access_denied', 'document_unavailable', 'output_write_failed']);
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
export const cueSchema = z.object({
  id: idSchema, sourceRevision: revision, timingRevision: revision,
  timing: z.object({ startMs: integer, endMs: integer.nullable(), provenance: z.enum(['srt', 'lrc_offset']) }).strict(),
  source: textSchema, sourceLabel: z.string().max(100).optional(), nodeId: idSchema,
}).strict().refine(cue => cue.timing.endMs === null || cue.timing.endMs >= cue.timing.startMs);
export const documentSchema = z.object({
  schemaVersion: z.literal(1), id: idSchema, revision,
  origin: z.object({ format: z.enum(['srt', 'lrc']), displayName: z.string().min(1).max(255), encoding: encodingSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  cues: z.array(cueSchema).max(LIMITS.cues),
  translationTracks: z.array(z.object({
    id: idSchema, language: z.string().max(100), revision,
    entries: z.record(idSchema, z.object({ sourceRevision: revision, sourceHash: z.string(), text: textSchema, origin: z.enum(['ai', 'human']), reviewStatus: z.enum(['unreviewed', 'reviewed']) }).strict()),
  }).strict()).max(100),
  capabilities: z.object({ translate: z.boolean(), preserveSource: z.literal(true) }).strict(),
  diagnostics: z.array(diagnosticSchema).max(LIMITS.cues * 2 + 1),
  preservation: z.object({
    schemaVersion: z.literal(1), rawText: z.string().max(LIMITS.inputBytes), bom: z.boolean(), newline: z.enum(['lf', 'crlf', 'mixed']), offsetMs: integer,
    nodes: z.array(z.object({ id: idSchema, start: integer.nonnegative(), end: integer.nonnegative(), cueIds: z.array(idSchema).max(LIMITS.cues) }).strict()).max(LIMITS.nodes),
  }).strict(),
}).strict();
export type SubtitleDocument = z.infer<typeof documentSchema>;
export type SubtitleCue = z.infer<typeof cueSchema>;
export type SubtitleText = z.infer<typeof textSchema>;
export type Encoding = z.infer<typeof encodingSchema>;

export function validateDocument(value: unknown): SubtitleDocument {
  const result = documentSchema.safeParse(value);
  if (!result.success) throw new StudioError('invalid_input');
  const doc = result.data;
  const ids = new Set(doc.cues.map(cue => cue.id));
  const nodes = new Map(doc.preservation.nodes.map(node => [node.id, node]));
  const mapped = new Set<string>();
  const cueNodes = new Map<string, string>();
  if (ids.size !== doc.cues.length || nodes.size !== doc.preservation.nodes.length) throw new StudioError('invalid_input');
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
  }
  const tracks = new Set<string>();
  for (const track of doc.translationTracks) {
    if (tracks.has(track.id)) throw new StudioError('invalid_input');
    tracks.add(track.id);
    for (const [cueId, entry] of Object.entries(track.entries)) {
      if (!ids.has(cueId) || entry.text.spans.map(span => span.text).join('') !== entry.text.plain || new TextEncoder().encode(entry.text.plain).length > LIMITS.cueBytes) throw new StudioError('invalid_input');
    }
  }
  return doc;
}
