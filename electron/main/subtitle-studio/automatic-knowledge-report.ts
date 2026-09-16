import { z } from 'zod';
import { idSchema, StudioError } from '../../../src/subtitle-studio/domain';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { AUTOMATIC_KNOWLEDGE_FAILURE_CODES, AUTOMATIC_KNOWLEDGE_REPORT_LIMITS as LIMITS,
  type AutomaticKnowledgeFailureCode, type AutomaticKnowledgeMaterialSummary, type AutomaticKnowledgeRecheckSeed,
  type AutomaticKnowledgeReportIssue, type AutomaticKnowledgeReportPage } from '../../../src/subtitle-studio/automatic-knowledge-report-contract';
import { KNOWLEDGE_ISSUE_CODES, normalizeKnowledgeSelection, type KnowledgeIssue } from '../../../src/translation-knowledge/execution-contract';
import { validateFrozenAutomaticKnowledge } from '../../../src/translation-knowledge/automatic-snapshot-contract';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { ENTITY_ARRAYS } from '../../../src/translation-knowledge/schemas';
import { documentSourceDigest } from './translation-recovery';

const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().max(LIMITS.name);
const issueSchema = z.object({ code: z.enum(KNOWLEDGE_ISSUE_CODES), severity: z.enum(['warning', 'error']),
  entryCount: count, cueCount: count,
  entries: z.array(z.object({ entryId: idSchema, title: name }).strict()).max(LIMITS.references),
  cues: z.array(z.object({ cueId: idSchema, number: count.refine(value => value > 0), text: z.string().max(LIMITS.excerpt) }).strict()).max(LIMITS.references),
}).strict().refine(issue => issue.entryCount >= issue.entries.length && issue.cueCount >= issue.cues.length
  && new Set(issue.entries.map(entry => entry.entryId)).size === issue.entries.length
  && new Set(issue.cues.map(cue => cue.cueId)).size === issue.cues.length);
const materialSchema = z.object({ recipeName: name.optional(), resourceCount: count, collectionCount: count,
  collections: z.array(name).max(LIMITS.references), documentTopicCount: count, documentTopics: z.array(name).max(LIMITS.references),
}).strict();
/** The private envelope is deliberately not part of the document read schema.
 * A damaged diagnostic must never select an older document generation. */
const reportSchema = z.object({ version: z.literal(1), createdAt: z.string().datetime(), documentId: idSchema,
  documentRevision: count.refine(value => value > 0), intentId: idSchema, taskId: idSchema, trackId: idSchema,
  sourceDigest: digest, timingDigest: digest, knowledgeDigest: digest, configDigest: digest,
  taskConfigDigest: digest, trackLanguage: z.string().max(100), error: z.enum(AUTOMATIC_KNOWLEDGE_FAILURE_CODES),
  issueCount: count, issuesTruncated: z.boolean(), issues: z.array(issueSchema).max(LIMITS.issues), material: materialSchema, digest,
}).strict().refine(report => report.issueCount >= report.issues.length && report.issuesTruncated ===
  (report.issueCount > report.issues.length || report.issues.some(issue => issue.entryCount > issue.entries.length || issue.cueCount > issue.cues.length)));
export type AutomaticKnowledgePreparationReport = z.infer<typeof reportSchema>;
const bytes = (value: unknown) => {
  const json = JSON.stringify(value);
  if (json === undefined) invalid();
  return Buffer.byteLength(json, 'utf8');
};
const bounded = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
const timingDigest = (snapshot: DocumentSnapshot) => sha256Canonical(snapshot.document.cues.map(cue => [cue.id, cue.timingRevision, cue.timing]));
function invalid(): never { throw new StudioError('invalid_input'); }

function materialSummary(snapshot: DocumentSnapshot): AutomaticKnowledgeMaterialSummary {
  const frozen = snapshot.automaticTranslation!.knowledge!;
  const recipe = frozen.data.recipes.find(item => item.id === frozen.selection.recipeId);
  const collectionIds = [...new Set([...frozen.selection.collectionIds, ...recipe?.readCollectionIds ?? []])];
  const collections = new Map(frozen.data.collections.map(item => [item.id, item.name]));
  const subjects = new Map(frozen.data.subjects.map(item => [item.id, item.name]));
  return { ...(recipe ? { recipeName: bounded(recipe.name, LIMITS.name) } : {}),
    resourceCount: ENTITY_ARRAYS.reduce((sum, group) => sum + frozen.data[group].length, 0),
    collectionCount: collectionIds.length, collections: collectionIds.slice(0, LIMITS.references).map(id => bounded(collections.get(id) ?? id, LIMITS.name)),
    documentTopicCount: frozen.documentTopicIds.length,
    documentTopics: frozen.documentTopicIds.slice(0, LIMITS.references).map(id => bounded(subjects.get(id) ?? id, LIMITS.name)) };
}

/** Called only while atomically admitting the failed automatic task. */
export function createAutomaticKnowledgeReport(snapshot: DocumentSnapshot, taskId: string,
  error: AutomaticKnowledgeFailureCode, input: KnowledgeIssue[] = []): AutomaticKnowledgePreparationReport {
  const intent = snapshot.automaticTranslation!, task = snapshot.tasks.find(item => item.id === taskId)!;
  if (!intent?.knowledge || !task?.translation || task.status !== 'failed' || task.attempts !== 0) invalid();
  const entries = new Map(intent.knowledge.data.entries.map(entry => [entry.id, entry]));
  const cues = new Map(snapshot.document.cues.map((cue, index) => [cue.id, { cue, number: index + 1 }]));
  const issues: AutomaticKnowledgeReportIssue[] = input.slice(0, LIMITS.issues).map(issue => {
    const entryIds = [...new Set(issue.entryIds)], cueIds = [...new Set(issue.cueIds)];
    // Refuse invented references instead of preserving compiler/provider strings.
    if (entryIds.some(id => !entries.has(id)) || cueIds.some(id => !cues.has(id))) invalid();
    return { code: issue.code, severity: issue.severity, entryCount: entryIds.length, cueCount: cueIds.length,
      entries: entryIds.slice(0, LIMITS.references).map(entryId => ({ entryId, title: bounded(entries.get(entryId)!.title, LIMITS.name) })),
      cues: cueIds.slice(0, LIMITS.references).map(cueId => ({ cueId, number: cues.get(cueId)!.number,
        text: bounded(cues.get(cueId)!.cue.source.plain, LIMITS.excerpt) })) };
  });
  const base = { version: 1 as const, createdAt: new Date().toISOString(), documentId: snapshot.document.id,
    // Repository increments once after this synchronous mutation.
    documentRevision: snapshot.document.revision + 1, intentId: intent.intentId, taskId, trackId: task.trackId,
    sourceDigest: documentSourceDigest(snapshot.document), timingDigest: timingDigest(snapshot),
    knowledgeDigest: sha256Canonical(intent.knowledge), configDigest: sha256Canonical(intent.config),
    taskConfigDigest: sha256Canonical(task.translation.config), trackLanguage: snapshot.document.translationTracks.find(track => track.id === task.trackId)!.language,
    error, issueCount: input.length, issuesTruncated: false, issues, material: materialSummary(snapshot) };
  // Account for each omitted issue once; repeated hashing of shrinking reports
  // would block the main process on large conflict sets. `false` is one byte
  // longer than `true`, so this provisional envelope conservatively fits both.
  let size = bytes({ ...base, digest: '0'.repeat(64) });
  while (size > LIMITS.bytes) {
    const omitted = base.issues.pop();
    if (!omitted) invalid();
    size -= bytes(omitted) + (base.issues.length ? 1 : 0);
  }
  base.issuesTruncated = base.issueCount > base.issues.length || base.issues.some(issue => issue.entryCount > issue.entries.length || issue.cueCount > issue.cues.length);
  return validateAutomaticKnowledgeReport({ ...base, digest: sha256Canonical(base) }, snapshot, true);
}

/** Strict for new reports, or on explicit inspection; never on ordinary reads. */
export function validateAutomaticKnowledgeReport(value: unknown, snapshot: DocumentSnapshot, admission = false): AutomaticKnowledgePreparationReport {
  if (bytes(value) > LIMITS.bytes) invalid();
  const result = reportSchema.safeParse(value);
  if (!result.success) invalid();
  const report = result.data!, { digest: checksum, ...base } = report;
  const intent = snapshot.automaticTranslation, task = snapshot.tasks.find(item => item.id === report.taskId);
  const track = snapshot.document.translationTracks.find(item => item.id === report.trackId);
  if (sha256Canonical(base) !== checksum || !intent?.knowledge || !track || intent.state === 'pending'
    || report.documentId !== snapshot.document.id || report.intentId !== intent.intentId || report.taskId !== intent.translationTaskId
    || task && (task.trackId !== report.trackId || !task.translation) || sha256Canonical(intent.knowledge) !== report.knowledgeDigest
    || !admission && report.documentRevision > snapshot.document.revision
    || sha256Canonical(materialSummary(snapshot)) !== sha256Canonical(report.material)) invalid();
  if (admission && (!task?.translation || task.status !== 'failed' || task.attempts !== 0 || task.translation.error !== report.error
    || report.documentRevision !== snapshot.document.revision + 1 || report.sourceDigest !== documentSourceDigest(snapshot.document)
    || report.timingDigest !== timingDigest(snapshot) || report.configDigest !== sha256Canonical(intent.config)
    || report.taskConfigDigest !== sha256Canonical(task.translation.config) || report.trackLanguage !== track.language)) invalid();
  const entries = new Map(intent.knowledge.data.entries.map(entry => [entry.id, entry]));
  const sourceUnchanged = report.sourceDigest === documentSourceDigest(snapshot.document);
  const cues = new Map(snapshot.document.cues.map((cue, index) => [cue.id, { cue, number: index + 1 }]));
  for (const issue of report.issues) {
    for (const ref of issue.entries) if (!entries.has(ref.entryId) || bounded(entries.get(ref.entryId)!.title, LIMITS.name) !== ref.title) invalid();
    if (sourceUnchanged) for (const ref of issue.cues) {
      const current = cues.get(ref.cueId);
      if (!current || current.number !== ref.number || bounded(current.cue.source.plain, LIMITS.excerpt) !== ref.text) invalid();
    }
  }
  return report;
}

function recheckSeed(snapshot: DocumentSnapshot, taskId: string, trackId: string): AutomaticKnowledgeRecheckSeed | null {
  try {
    const intent = snapshot.automaticTranslation!, frozen = validateFrozenAutomaticKnowledge(intent.knowledge);
    const seed: AutomaticKnowledgeRecheckSeed = { documentId: snapshot.document.id, trackId, intentId: intent.intentId, taskId,
      config: structuredClone(intent.config), selection: normalizeKnowledgeSelection({ ...frozen.selection, bindings: [], confirmations: [] }),
      documentTopicIds: [...frozen.documentTopicIds] };
    sha256Canonical(seed); // Reject legacy strings that cannot enter a canonical new request.
    // Reuse is all-or-nothing; a partial list would silently change the user's choices.
    return bytes(seed) <= LIMITS.seedBytes ? seed : null;
  } catch { return null; }
}

/** Public discovery contains opaque track IDs only, never report/snapshot data. */
export function automaticKnowledgeReportTrackIds(snapshot: DocumentSnapshot): string[] {
  const intent = snapshot.automaticTranslation;
  if (!intent?.knowledge) return [];
  const task = snapshot.tasks.find(item => item.id === intent.translationTaskId);
  if (task && snapshot.document.translationTracks.some(track => track.id === task.trackId)
    && (intent.preparationReport !== undefined || task.status === 'failed' && task.attempts === 0 && !task.translation?.checkpoint)) return [task.trackId];
  if (intent.preparationReport !== undefined) {
    try { return [validateAutomaticKnowledgeReport(intent.preparationReport, snapshot).trackId]; } catch { /* No trusted identity remains. */ }
  }
  return [];
}

/** Pure bounded projection. No initialization, planning, library reads or writes. */
export function readAutomaticKnowledgeReportPage(snapshot: DocumentSnapshot, trackId: string): AutomaticKnowledgeReportPage {
  const track = snapshot.document.translationTracks.find(item => item.id === trackId);
  if (!track) throw new StudioError('revision_conflict');
  const intent = snapshot.automaticTranslation;
  if (!intent?.knowledge) return { state: 'none' };
  const task = snapshot.tasks.find(item => item.id === intent.translationTaskId);
  if (intent.preparationReport === undefined) {
    if (task?.trackId !== trackId || task.status !== 'failed' || task.attempts !== 0 || task.translation?.checkpoint) return { state: 'none' };
    return { state: 'legacy', seed: recheckSeed(snapshot, task.id, trackId) };
  }
  try {
    const report = validateAutomaticKnowledgeReport(intent.preparationReport, snapshot);
    if (report.trackId !== trackId) return { state: 'none' };
    const sourceChanged = report.sourceDigest !== documentSourceDigest(snapshot.document);
    const stale = sourceChanged || report.timingDigest !== timingDigest(snapshot) || report.configDigest !== sha256Canonical(intent.config)
      || report.trackLanguage !== track.language || !!task?.translation && report.taskConfigDigest !== sha256Canonical(task.translation.config);
    return { state: 'available', createdAt: report.createdAt, documentRevision: report.documentRevision, stale, sourceChanged,
      error: report.error, issueCount: report.issueCount, issuesTruncated: report.issuesTruncated, issues: structuredClone(report.issues),
      material: structuredClone(report.material), seed: recheckSeed(snapshot, report.taskId, trackId) };
  } catch { return task && task.trackId !== trackId ? { state: 'none' } : { state: 'unavailable' }; }
}
