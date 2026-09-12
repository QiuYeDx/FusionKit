// Maintenance-only evidence analysis. No inference, text normalization or quality verdict.
import type { LocalSubtitleTranscript } from '../../src/type/localSubtitle';
import { validateDocument, type MediaSubtitleDocument } from '../../src/subtitle-studio/domain';

export interface RealDefaultRawAttempt {
  readonly ordinal: number;
  readonly window?: unknown;
  readonly request: Record<string, unknown>;
  readonly response?: unknown;
  readonly error?: { name: string; code?: string; message: string };
}

export interface RealDefaultWindowPlan {
  readonly totalFrames: number;
  readonly quietCandidates?: readonly { startFrame: number; endFrame: number }[];
  readonly windows: readonly Record<string, unknown>[];
}

type CueProjection = { startMs: number; endMs: number; text: string };
export interface RealDefaultComparisonSide {
  readonly canonicalTranscript: LocalSubtitleTranscript;
  readonly document?: MediaSubtitleDocument;
  readonly documentCues?: readonly CueProjection[];
  readonly rawAttempts?: readonly RealDefaultRawAttempt[];
  readonly windowPlan?: RealDefaultWindowPlan;
}

// Explicit presence survives JSON serialization, including an explicitly undefined field.
type EvidenceValue = { present: false } | { present: true; type: 'undefined' }
  | { present: true; type: 'value'; value: unknown };
export interface RealDefaultFieldDifference {
  readonly path: string;
  readonly legacy: EvidenceValue;
  readonly studio: EvidenceValue;
}

const owns = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const frame = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const pointer = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');
function valueAt(value: unknown, present: boolean): EvidenceValue {
  if (!present) return { present: false };
  if (value === undefined) return { present: true, type: 'undefined' };
  return { present: true, type: 'value', value: structuredClone(value) };
}

/** Ordered comparison: insertion/deletion is retained at its actual index, never fuzzy-aligned. */
function differences(legacy: unknown, studio: unknown, base = ''): RealDefaultFieldDifference[] {
  const result: RealDefaultFieldDifference[] = [];
  const visit = (left: unknown, right: unknown, location: string, hasLeft = true, hasRight = true) => {
    if (hasLeft === hasRight && Object.is(left, right)) return;
    if (hasLeft && hasRight && Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        visit(left[index], right[index], `${location}/${index}`, owns(left, index), owns(right, index));
      }
      return;
    }
    if (hasLeft && hasRight && object(left) && object(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        visit(left[key], right[key], `${location}/${pointer(key)}`, owns(left, key), owns(right, key));
      }
      return;
    }
    result.push({ path: location, legacy: valueAt(left, hasLeft), studio: valueAt(right, hasRight) });
  };
  visit(legacy, studio, base);
  return result;
}

function project(transcript: LocalSubtitleTranscript): CueProjection[] {
  return transcript.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
}

function documentEvidence(side: RealDefaultComparisonSide) {
  const projected = side.documentCues === undefined ? undefined : differences(project(side.canonicalTranscript), side.documentCues);
  if (!side.document) return {
    availability: side.documentCues === undefined ? 'not_captured' as const : 'projection_only' as const,
    projectionEqual: projected === undefined ? null : projected.length === 0,
    projectionDifferences: projected ?? [],
    validDocument: null, canonicalEqual: null, mappingEqual: null,
    canonicalDifferences: [], mappingDifferences: [],
  };
  let validDocument = true;
  try { if (validateDocument(side.document).schemaVersion !== 2) validDocument = false; }
  catch { validDocument = false; }
  const canonicalDifferences = differences(side.canonicalTranscript, side.document.preservation.transcript, '/preservation/transcript');
  // The document owns fresh cue UUIDs. Every other cue field must match the producer contract exactly.
  const expected = side.canonicalTranscript.segments.map((segment, index) => ({
    id: side.document!.cues[index]?.id,
    sourceRevision: 1, timingRevision: 1,
    timing: { startMs: segment.startMs, endMs: segment.endMs, provenance: 'transcription' },
    source: { plain: segment.text, spans: [{ text: segment.text, marks: [] }] },
    segmentId: segment.id,
  }));
  const mappingDifferences = differences(expected, side.document.cues, '/cues');
  return {
    availability: 'full_document' as const,
    projectionEqual: projected === undefined ? null : projected.length === 0,
    projectionDifferences: projected ?? [], validDocument,
    canonicalEqual: canonicalDifferences.length === 0, mappingEqual: mappingDifferences.length === 0,
    canonicalDifferences, mappingDifferences,
  };
}

function repeated<T extends { text: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.text) ?? [];
    group.push(item); groups.set(item.text, group);
  }
  return [...groups].filter(([, locations]) => locations.length > 1)
    .map(([text, locations]) => ({ text, locations: locations.map(({ text: _text, ...location }) => location) }));
}

function cueLocations(transcript: LocalSubtitleTranscript) {
  return transcript.segments.map(({ id, startMs, endMs, text }, index) => ({ index, id, startMs, endMs, text }));
}

const GEOMETRY_FIELDS = ['startFrame', 'endFrame', 'coreStartFrame', 'coreEndFrame',
  'startMs', 'endMs', 'coreStartMs', 'coreEndMs'] as const;
type Geometry = Record<typeof GEOMETRY_FIELDS[number], number>;
function windowGeometry(value: unknown): Geometry | null {
  // Observers can retain the branded window or its exact structural descriptor.
  const descriptor = object(value) && object(value.descriptor) ? value.descriptor : value;
  if (!object(descriptor)) return null;
  if (!GEOMETRY_FIELDS.every(key => finite(descriptor[key]))) return null;
  const result = Object.fromEntries(GEOMETRY_FIELDS.map(key => [key, descriptor[key]])) as Geometry;
  if (![result.startFrame, result.endFrame, result.coreStartFrame, result.coreEndFrame].every(frame)
    || result.endFrame <= result.startFrame || result.coreStartFrame < result.startFrame
    || result.coreEndFrame > result.endFrame || result.coreEndFrame <= result.coreStartFrame) return null;
  // Production rounds frame positions in the normalized 16 kHz media timeline.
  if (['start', 'end', 'coreStart', 'coreEnd'].some(key =>
    result[`${key}Ms` as keyof Geometry] !== Math.round(result[`${key}Frame` as keyof Geometry] / 16))) return null;
  return result;
}

function planEvidence(plan?: RealDefaultWindowPlan) {
  if (!plan) return { availability: 'not_captured' as const, geometry: null, unsupportedWindowIndices: [] as number[] };
  const windows = plan.windows.map(windowGeometry);
  const unsupportedWindowIndices = windows.flatMap((value, index) => value === null ? [index] : []);
  const quietValid = plan.quietCandidates === undefined || plan.quietCandidates.every(range =>
    frame(range.startFrame) && frame(range.endFrame) && range.endFrame > range.startFrame && range.endFrame <= plan.totalFrames);
  const valid = frame(plan.totalFrames) && plan.totalFrames > 0 && quietValid && windows.length > 0
    && !unsupportedWindowIndices.length && windows.every(window => window!.endFrame <= plan.totalFrames);
  return {
    availability: valid ? 'captured' as const : 'unsupported' as const,
    geometry: { totalFrames: plan.totalFrames, ...(plan.quietCandidates === undefined ? {} : { quietCandidates: structuredClone(plan.quietCandidates) }), windows },
    unsupportedWindowIndices,
  };
}

interface RawSegmentLocation {
  text: string; observationIndex: number; ordinal: number; segmentIndex: number; segmentId: number;
  localStartMs: number; localEndMs: number; absoluteStartMs: number | null; absoluteEndMs: number | null;
  window: Geometry | null;
}

function rawEvidence(attempts?: readonly RealDefaultRawAttempt[]) {
  const locations: RawSegmentLocation[] = [];
  const observations = (attempts ?? []).map((attempt, observationIndex) => {
    const geometry = windowGeometry(attempt.window);
    const outer = attempt.response;
    const response = object(outer) && object(outer.response) ? outer.response : null;
    const result = response && object(response.result) ? response.result : null;
    const segments = result && Array.isArray(result.segments) ? result.segments : null;
    const supported = object(outer) && frame(outer.processEpoch) && response && frame(response.requestGeneration)
      && response.sessionDisposition === 'reusable' && result && result.contractVersion === 1
      && ['transcribe', 'translate'].includes(result.task as string) && typeof result.language === 'string'
      && finite(result.durationMs) && typeof result.text === 'string'
      && ['not_requested', 'dtw_token_points', 'discarded_vad_compressed_timeline'].includes(result.wordTimelineStatus as string)
      && segments && segments.every(segment => object(segment) && frame(segment.id)
        && finite(segment.startMs) && finite(segment.endMs) && segment.startMs >= 0 && segment.endMs >= segment.startMs
        && typeof segment.text === 'string' && finite(segment.temperature)
        && finite(segment.averageLogProbability) && finite(segment.noSpeechProbability)
        && (segment.dtwTokens === undefined || (Array.isArray(segment.dtwTokens) && segment.dtwTokens.every(token =>
          object(token) && typeof token.text === 'string' && (token.pointMs === null || finite(token.pointMs))))));
    if (supported) segments!.forEach((segment, segmentIndex) => locations.push({
      text: segment.text, observationIndex, ordinal: attempt.ordinal, segmentIndex, segmentId: segment.id,
      localStartMs: segment.startMs, localEndMs: segment.endMs,
      absoluteStartMs: geometry ? geometry.startMs + segment.startMs : null,
      absoluteEndMs: geometry ? geometry.startMs + segment.endMs : null, window: geometry,
    }));
    return {
      observationIndex, ordinal: attempt.ordinal,
      status: supported ? 'response' as const : attempt.response !== undefined ? 'unsupported_response' as const
        : attempt.error ? 'error' as const : 'missing_response' as const,
      window: geometry,
      quietAudioGainDb: object(attempt.window) && finite(attempt.window.quietAudioGainDb) ? attempt.window.quietAudioGainDb : null,
      vadEnabled: typeof attempt.request.vadEnabled === 'boolean' ? attempt.request.vadEnabled : null,
      timingMode: typeof attempt.request.timingMode === 'string' ? attempt.request.timingMode : null,
      wordTimelineStatus: supported ? result!.wordTimelineStatus as string : null,
      rawSegmentCount: supported ? segments!.length : null,
      dtwTokenPointCount: supported ? segments!.reduce((count, segment) => count + (segment.dtwTokens?.length ?? 0), 0) as number : null,
      ...(attempt.error ? { error: structuredClone(attempt.error) } : {}),
    };
  });
  return {
    availability: attempts === undefined ? 'not_captured' as const : 'captured' as const,
    observations, segments: locations,
    exactTextRepetitions: repeated(locations).map(group => ({ ...group,
      acrossAttempts: new Set(group.locations.map(location => location.observationIndex)).size > 1,
      acrossWindowGeometry: new Set(group.locations.filter(location => location.window).map(location => JSON.stringify(location.window))).size > 1,
    })),
  };
}

export function analyzeRealDefaultComparison(input: {
  sampleId: string; backend: 'cpu' | 'cuda'; legacy: RealDefaultComparisonSide; studio: RealDefaultComparisonSide;
  /** In repeat controls the legacy/studio slots mean first/repeat, respectively. */
  comparisonKind?: 'migration' | 'legacy_repeat' | 'studio_repeat';
}) {
  const comparisonKind = input.comparisonKind ?? 'migration';
  const canonicalDifferences = differences(input.legacy.canonicalTranscript, input.studio.canonicalTranscript);
  const identityDifferences = canonicalDifferences.filter(difference => /^\/segments\/\d+\/id$/.test(difference.path));
  const semanticDifferences = canonicalDifferences.filter(difference => !/^\/segments\/\d+\/id$/.test(difference.path));
  const legacyCues = cueLocations(input.legacy.canonicalTranscript), studioCues = cueLocations(input.studio.canonicalTranscript);
  const textDifferences = Array.from({ length: Math.max(legacyCues.length, studioCues.length) }, (_, index) => ({
    index, legacy: legacyCues[index] ?? null, studio: studioCues[index] ?? null,
  })).filter(pair => pair.legacy?.text !== pair.studio?.text);
  const documents = { legacy: documentEvidence(input.legacy), studio: documentEvidence(input.studio) };
  const plans = { legacy: planEvidence(input.legacy.windowPlan), studio: planEvidence(input.studio.windowPlan) };
  const planDifferences = differences(plans.legacy.geometry, plans.studio.geometry);
  const raw = { legacy: rawEvidence(input.legacy.rawAttempts), studio: rawEvidence(input.studio.rawAttempts) };
  const reviewReasons: string[] = [];
  if (semanticDifferences.length) reviewReasons.push('canonical_semantic_differences');
  if ([input.legacy, input.studio].some(side => side.canonicalTranscript.model.backend !== input.backend)) reviewReasons.push('backend_mismatch');
  for (const side of ['legacy', 'studio'] as const) {
    if (documents[side].validDocument === false || documents[side].canonicalEqual === false || documents[side].mappingEqual === false
      || documents[side].projectionEqual === false) reviewReasons.push(`${side}_document_mismatch`);
    if (plans[side].availability !== 'captured') reviewReasons.push(`${side}_window_evidence_incomplete`);
    if (raw[side].availability !== 'captured' || !raw[side].observations.length
      || raw[side].observations.some(observation => !observation.window || ['unsupported_response', 'missing_response'].includes(observation.status))) {
      reviewReasons.push(`${side}_raw_evidence_incomplete`);
    }
  }
  if (comparisonKind !== 'legacy_repeat' && documents.studio.availability !== 'full_document') reviewReasons.push('studio_full_document_not_captured');
  if (comparisonKind === 'studio_repeat' && documents.legacy.availability !== 'full_document') reviewReasons.push('legacy_full_document_not_captured');
  if (plans.legacy.availability === 'captured' && plans.studio.availability === 'captured' && planDifferences.length) reviewReasons.push('window_geometry_differences');
  return {
    schemaVersion: 1 as const, sampleId: input.sampleId, backend: input.backend, comparisonKind,
    comparisonBasis: 'ordered_exact_fields_without_fuzzy_alignment' as const,
    canonical: { equal: !canonicalDifferences.length, semanticEqual: !semanticDifferences.length,
      differences: canonicalDifferences, semanticDifferences, identityDifferences },
    textDifferences,
    exactTextRepetitions: { legacy: repeated(legacyCues), studio: repeated(studioCues) },
    documents, windows: { ...plans, comparable: plans.legacy.availability === 'captured' && plans.studio.availability === 'captured',
      equal: plans.legacy.availability === 'captured' && plans.studio.availability === 'captured' ? !planDifferences.length : null,
      differences: planDifferences }, raw,
    summary: { legacyCueCount: legacyCues.length, studioCueCount: studioCues.length, differingTextCueCount: textDifferences.length,
      semanticDifferenceCount: semanticDifferences.length, identityDifferenceCount: identityDifferences.length,
      firstSemanticDifferencePaths: semanticDifferences.slice(0, 20).map(difference => difference.path),
      remainingSemanticDifferencePathCount: Math.max(0, semanticDifferences.length - 20) },
    requiresReview: reviewReasons.length > 0, reviewReasons,
    limitations: [
      'Equality demonstrates migration preservation for this fixed sample, not recognition accuracy or human acceptance.',
      'Exact repeated text is a location aid; it may be legitimate speech, overlap, or retry output. No text is removed or merged.',
      'Raw attempt output may later be discarded. DTW points are token interiors, not word boundaries; VAD segments use their mapped timeline.',
      'An empty ASR result does not establish acoustic silence. Failure/no_speech outcomes belong in the surrounding run report.',
      'The complete canonical, document, request and window evidence must remain in the surrounding report.',
    ],
  };
}

export type RealDefaultComparisonAnalysis = ReturnType<typeof analyzeRealDefaultComparison>;
