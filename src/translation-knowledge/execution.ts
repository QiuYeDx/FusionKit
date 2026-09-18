import type { LibrarySnapshot } from './ipc-contract';
import type { Entry } from './schemas';
import { sha256Canonical } from './canonicalize';
import { MATCH_POLICY_VERSION, matchLiteral, normalizeForMatching } from './matching';
import { knowledgeSelectionSchema, normalizeKnowledgeSelection, type KnowledgeSelection, type KnowledgeCue, type KnowledgeEnvironment, type KnowledgeIssue, type CompiledKnowledgeItem, type BatchKnowledge, type CompiledKnowledge } from './execution-contract';

/** Frozen v1 preparations must keep their original rule-conflict semantics. */
export const LEGACY_KNOWLEDGE_EXECUTION_POLICY = 'fktk-execution/1;fk-tk-match/1-unicode-16.0.0;context-term-rule' as const;
export const KNOWLEDGE_EXECUTION_POLICY = `fktk-execution/2;${MATCH_POLICY_VERSION};context-term-rule` as const;
export type KnowledgeExecutionPolicy = typeof LEGACY_KNOWLEDGE_EXECUTION_POLICY | typeof KNOWLEDGE_EXECUTION_POLICY;
export const supportedKnowledgeExecutionPolicy = (value: unknown): value is KnowledgeExecutionPolicy =>
  value === KNOWLEDGE_EXECUTION_POLICY || value === LEGACY_KNOWLEDGE_EXECUTION_POLICY;
/** P1.1 preview is deliberately bounded before serialization. Exceeding any work
 * budget blocks the entire environment; required knowledge is never truncated. */
export const KNOWLEDGE_EXECUTION_LIMITS = Object.freeze({
  entries: 2000, termsAndRules: 500, termVariants: 128, matches: 5000,
  scanBytes: 8 * 1024 * 1024, conflictComparisons: 1_000_000, diagnostics: 5000,
});
const copy = <T>(value: T): T => structuredClone(value);
const issue = (code: KnowledgeIssue['code'], entryIds: string[] = [], cueIds: string[] = [], severity: KnowledgeIssue['severity'] = 'warning'): KnowledgeIssue => ({ code, severity, entryIds, cueIds });
const samePair = (left: { source: string; target: string }, right: { source: string; target: string }) => left.source === right.source && left.target === right.target;
const unique = <T>(values: T[]) => [...new Set(values)];

/** Pure resolution. Only the main process supplies the locally verified library. */
export function resolveEnvironment(library: LibrarySnapshot, input: KnowledgeSelection, inputCues: KnowledgeCue[], policyVersion: KnowledgeExecutionPolicy = KNOWLEDGE_EXECUTION_POLICY): KnowledgeEnvironment {
  if (!supportedKnowledgeExecutionPolicy(policyVersion)) throw new TypeError('Unsupported knowledge execution policy');
  const parsed = knowledgeSelectionSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid knowledge selection');
  if (!inputCues.length || inputCues.length > 20 || new Set(inputCues.map(cue => cue.id)).size !== inputCues.length || inputCues.some(cue => !cue.id || !cue.text || new TextEncoder().encode(cue.text).byteLength > 65536)) throw new TypeError('Invalid knowledge cues');
  const selection = normalizeKnowledgeSelection(parsed.data), cues = copy(inputCues), cueIds = new Set(cues.map(cue => cue.id));
  const issues: KnowledgeIssue[] = [], items: CompiledKnowledgeItem[] = [];
  const encoder = new TextEncoder();
  let resourceExceeded = false, scanBytes = 0, matchCount = 0, conflictComparisons = 0;
  const limit = (entryIds: string[] = []) => {
    if (resourceExceeded) return;
    resourceExceeded = true;
    // Empty cue IDs deliberately make incomplete analysis block every batch.
    issues.push(issue('resource_limit', entryIds, [], 'error'));
  };
  const add = (value: KnowledgeIssue) => {
    if (issues.length >= KNOWLEDGE_EXECUTION_LIMITS.diagnostics) { limit(); return; }
    issues.push(value);
  };
  const chargeScan = (bytes: number, entryId: string) => {
    scanBytes += bytes;
    if (scanBytes > KNOWLEDGE_EXECUTION_LIMITS.scanBytes) { limit([entryId]); return false; }
    return true;
  };
  const cueBytes = new Map(cues.map(cue => [cue.id, encoder.encode(cue.text).byteLength]));
  if (library.maintenance?.cleanupPending) add(issue('resource_missing', [], [], 'error'));
  for (const binding of [...selection.bindings, ...selection.confirmations]) if (binding.cueIds.some(id => !cueIds.has(id))) add(issue('selection_invalid', [], [], 'error'));
  const subjects = new Map(library.data.subjects.map(item => [item.id, item]));
  for (const binding of selection.bindings) {
    const subject = subjects.get(binding.subjectId);
    if (!subject || subject.archived || binding.role === 'speaker' && subject.kind !== 'person') add(issue('selection_invalid', [], binding.cueIds, 'error'));
  }
  const recipe = selection.recipeId ? library.data.recipes.find(item => item.id === selection.recipeId) : undefined;
  if (selection.recipeId && !recipe) add(issue('resource_missing', [], [], 'error'));
  if (recipe?.archived) add(issue('resource_archived', [], [], 'error'));
  if (recipe && !samePair(recipe.languagePair, selection.languagePair)) add(issue('language_mismatch', [], [], 'error'));
  // Recipe roles are suggestions only: never materialize them as current-file facts.
  if (recipe?.inheritGlobalPreferences) add(issue('preferences_not_applied'));
  const selectedIds = unique([...selection.collectionIds, ...(recipe?.readCollectionIds ?? [])]);
  const selectedSet = new Set(selectedIds), disabled = new Set(selection.disabledEntryIds);
  const collections = selectedIds.flatMap(id => {
    const collection = library.data.collections.find(item => item.id === id);
    if (!collection) { add(issue('resource_missing', [], [], 'error')); return []; }
    if (collection.archived) add(issue('resource_archived', [], [], 'error'));
    return [collection];
  });
  const collectionById = new Map(collections.map(item => [item.id, item]));
  const entriesById = new Map(library.data.entries.map(item => [item.id, item]));
  const sourceById = new Map(library.data.sources.map(item => [item.id, item]));
  const trusted = (entry: Entry) => {
    const approval = library.approvals[entry.id];
    return entry.state === 'ready' && !!approval && approval.revision === entry.revision && approval.digest === sha256Canonical(entry);
  };
  const styleIds = recipe ? [recipe.baseStyleId, ...recipe.modifierStyleIds].filter((id): id is string => !!id) : [];
  for (const id of styleIds) {
    const style = library.data.styles.find(item => item.id === id);
    if (!style || style.archived || !samePair(style.languagePair, selection.languagePair)) { add(issue('style_unavailable', [], [], 'error')); continue; }
    for (const id of style.ruleEntryIds) {
      const rule = entriesById.get(id);
      if (!rule || rule.kind !== 'rule' || !selectedSet.has(rule.collectionId) || !trusted(rule) || collectionById.get(rule.collectionId)?.archived || rule.scope.requiredSubjects.some(binding => subjects.get(binding.subjectId)?.archived)) add(issue('style_unavailable', [id], [], 'error'));
    }
  }
  for (const id of selection.disabledEntryIds) if (!entriesById.has(id)) add(issue('selection_invalid', [id], [], 'error'));
  for (const confirmation of selection.confirmations) if (entriesById.get(confirmation.entryId)?.scope.condition.mode !== 'requires_confirmation') add(issue('selection_invalid', [confirmation.entryId], confirmation.cueIds, 'error'));
  const speakers = new Map(cues.map(cue => [cue.id, unique(selection.bindings.filter(binding => binding.role === 'speaker' && binding.cueIds.includes(cue.id)).map(binding => binding.subjectId))]));
  const candidates = library.data.entries.filter(entry => selectedSet.has(entry.collectionId));
  const withinLimits = candidates.length <= KNOWLEDGE_EXECUTION_LIMITS.entries &&
    candidates.filter(entry => entry.kind === 'term' || entry.kind === 'rule').length <= KNOWLEDGE_EXECUTION_LIMITS.termsAndRules &&
    candidates.every(entry => entry.kind !== 'term' || entry.payload.aliases.length + 1 <= KNOWLEDGE_EXECUTION_LIMITS.termVariants);
  if (!withinLimits) limit();
  for (const cue of cues) if (cue.sourceLanguage !== selection.languagePair.source) add(issue('language_mismatch', [], [cue.id], 'error'));
  entries: for (const entry of (withinLimits ? [...candidates] : []).sort((a, b) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1)) {
    if (resourceExceeded) break;
    if (!selectedSet.has(entry.collectionId)) continue;
    if (disabled.has(entry.id)) { add(issue('disabled', [entry.id])); continue; }
    if (!samePair(entry.scope.languagePair, selection.languagePair)) { add(issue('language_mismatch', [entry.id])); continue; }
    if (entry.kind === 'expression' || entry.kind === 'memory') { add(issue('unsupported_kind', [entry.id])); continue; }
    if (!trusted(entry)) { add(issue('untrusted', [entry.id])); continue; }
    if (collectionById.get(entry.collectionId)?.archived || entry.scope.requiredSubjects.some(binding => !subjects.has(binding.subjectId) || subjects.get(binding.subjectId)!.archived)) { add(issue('resource_archived', [entry.id])); continue; }
    const sources = unique([...entry.evidence.map(value => value.sourceId), ...entry.derivedFrom.map(value => value.evidenceSourceId)]);
    if (sources.some(id => !sourceById.has(id))) { add(issue('resource_missing', [entry.id], [], 'error')); continue; }
    const applicable: string[] = [], matches: CompiledKnowledgeItem['matches'] = [];
    for (const cue of cues) {
      if (resourceExceeded) break entries;
      if (cue.sourceLanguage !== selection.languagePair.source) { add(issue('language_mismatch', [entry.id], [cue.id])); continue; }
      if (entry.scope.requiredSubjects.some(required => !selection.bindings.some(binding => binding.subjectId === required.subjectId && (required.role === 'present' || binding.role === required.role) && binding.cueIds.includes(cue.id)))) { add(issue('subject_unbound', [entry.id], [cue.id])); continue; }
      if (entry.scope.requiredSubjects.some(binding => binding.role === 'speaker') && speakers.get(cue.id)!.length > 1) { add(issue('speaker_conflict', [entry.id], [cue.id], 'error')); continue; }
      if (entry.scope.condition.mode === 'requires_confirmation' && !selection.confirmations.some(value => value.entryId === entry.id && value.cueIds.includes(cue.id))) { add(issue('condition_unconfirmed', [entry.id], [cue.id])); continue; }
      if (entry.kind === 'term') {
        const seenNeedles = new Set<string>(), seenPositions = new Set<string>();
        for (let index = -1; index < entry.payload.aliases.length; index++) {
          const needle = index < 0 ? entry.payload.source : entry.payload.aliases[index];
          if (seenNeedles.has(needle)) continue;
          seenNeedles.add(needle);
          if (!chargeScan(cueBytes.get(cue.id)! + encoder.encode(needle).byteLength, entry.id)) break entries;
          // One result array is bounded by the 64 KiB cue cap. Never accumulate
          // arrays for all aliases before checking the whole-environment limit.
          for (const match of matchLiteral(cue.text, needle, entry.payload.match)) {
            const position = `${match.start}:${match.end}`;
            if (seenPositions.has(position)) continue;
            if (++matchCount > KNOWLEDGE_EXECUTION_LIMITS.matches) { limit([entry.id]); break entries; }
            seenPositions.add(position);
            matches.push({ cueId: cue.id, ...match, target: entry.payload.strength === 'keep_source' ? match.text : entry.payload.target });
          }
        }
        if (!seenPositions.size) { add(issue('no_match', [entry.id], [cue.id])); continue; }
      }
      applicable.push(cue.id);
    }
    if (!applicable.length) continue;
    items.push({ entryId: entry.id, revision: entry.revision, digest: sha256Canonical(entry), title: entry.title, kind: entry.kind,
      applicableCueIds: applicable, required: entry.kind === 'context' ? entry.payload.core : entry.payload.strength !== 'preferred',
      payload: copy(entry.payload), ...(entry.scope.condition.mode !== 'none' ? { condition: entry.scope.condition.text } : {}),
      evidence: sources.map(id => copy(sourceById.get(id)!)), matches });
  }
  // Conflicts are local to actual matches and cue scopes, never collection order.
  const remove = new Map<string, Set<string>>();
  const exclude = (item: CompiledKnowledgeItem, cueId: string) => { const ids = remove.get(item.entryId) ?? new Set<string>(); ids.add(cueId); remove.set(item.entryId, ids); };
  const targets = new Map<string, string>();
  const normalizedTarget = (text: string, entryId: string) => {
    const saved = targets.get(text);
    if (saved !== undefined) return saved;
    if (!chargeScan(encoder.encode(text).byteLength, entryId)) return undefined;
    const normalized = normalizeForMatching(text); targets.set(text, normalized); return normalized;
  };
  const compare = (entryIds: string[]) => {
    if (++conflictComparisons > KNOWLEDGE_EXECUTION_LIMITS.conflictComparisons) { limit(entryIds); return false; }
    return true;
  };
  // A dimension categorizes free-text rules; different text does not establish
  // a contradiction. Only frozen v1 preparations retain the former behavior.
  const conflictItems = resourceExceeded ? [] : items.filter(item => item.kind === 'term' || policyVersion === LEGACY_KNOWLEDGE_EXECUTION_POLICY && item.kind === 'rule');
  // Stable fingerprints bound repeated long-text rule comparisons as well.
  const ruleTextDigests = new Map<string, string>();
  for (const item of conflictItems) if (item.kind === 'rule' && 'text' in item.payload) {
    if (!chargeScan(encoder.encode(item.payload.text).byteLength, item.entryId)) break;
    ruleTextDigests.set(item.entryId, sha256Canonical(item.payload.text));
  }
  conflicts: for (let i = 0; i < conflictItems.length; i++) for (let j = i + 1; j < conflictItems.length; j++) {
    if (resourceExceeded) break conflicts;
    const left = conflictItems[i], right = conflictItems[j];
    if (left.kind !== right.kind) continue;
    const entryIds = [left.entryId, right.entryId];
    if (!compare(entryIds)) break conflicts;
    const intersection = left.applicableCueIds.filter(id => right.applicableCueIds.includes(id));
    for (const cueId of intersection) {
      let conflict = false;
      if (!compare(entryIds)) break conflicts;
      if (left.kind === 'term') {
        const leftMatches = left.matches.filter(match => match.cueId === cueId), rightMatches = right.matches.filter(match => match.cueId === cueId);
        pair: for (const a of leftMatches) for (const b of rightMatches) {
          if (!compare(entryIds)) break conflicts;
          if (a.start >= b.end || b.start >= a.end) continue;
          const aTarget = normalizedTarget(a.target, left.entryId), bTarget = normalizedTarget(b.target, right.entryId);
          if (resourceExceeded) break conflicts;
          if (aTarget !== bTarget) { conflict = true; break pair; }
        }
      } else {
        conflict = 'dimension' in left.payload && 'dimension' in right.payload && left.payload.dimension === right.payload.dimension && ruleTextDigests.get(left.entryId) !== ruleTextDigests.get(right.entryId);
      }
      if (!conflict) continue;
      add(issue(left.kind === 'term' ? 'term_conflict' : 'rule_conflict', [left.entryId, right.entryId], [cueId], left.required && right.required ? 'error' : 'warning'));
      if (resourceExceeded) break conflicts;
      if (!left.required) exclude(left, cueId);
      if (!right.required) exclude(right, cueId);
    }
  }
  if (resourceExceeded) items.length = 0;
  for (const item of items) {
    item.applicableCueIds = item.applicableCueIds.filter(id => !remove.get(item.entryId)?.has(id));
    item.matches = item.matches.filter(match => item.applicableCueIds.includes(match.cueId));
  }
  const base = { policyVersion, generation: library.generation, sourceDigest: sha256Canonical(cues), configDigest: sha256Canonical(selection),
    selection: copy(selection), cues, instructions: selection.instructions ?? recipe?.instructions ?? '', context: selection.context ?? recipe?.context ?? '',
    items: items.filter(item => item.applicableCueIds.length), issues: compactIssues(issues),
    collections: collections.map(({ id, name }) => ({ id, name })), ...(recipe ? { recipeName: recipe.name } : {}) };
  return { ...base, digest: sha256Canonical(base) };
}

function compactIssues(issues: KnowledgeIssue[]): KnowledgeIssue[] {
  const collected = new Map<string, KnowledgeIssue>();
  for (const value of issues) {
    const key = `${value.code}:${value.severity}:${value.entryIds.join(',')}`;
    const previous = collected.get(key);
    if (previous) previous.cueIds = !previous.cueIds.length || !value.cueIds.length ? [] : unique([...previous.cueIds, ...value.cueIds]);
    else collected.set(key, copy(value));
  }
  return [...collected.values()];
}

export function selectBatchKnowledge(environment: KnowledgeEnvironment, cueIds: string[]): BatchKnowledge {
  const selected = new Set(cueIds);
  if (!cueIds.length || selected.size !== cueIds.length || cueIds.some(id => !environment.cues.some(cue => cue.id === id))) throw new TypeError('Unknown batch cue');
  const items = environment.items.flatMap(item => {
    const applicableCueIds = item.applicableCueIds.filter(id => selected.has(id));
    return applicableCueIds.length ? [{ ...copy(item), applicableCueIds, matches: copy(item.matches.filter(match => selected.has(match.cueId))) }] : [];
  });
  return { policyVersion: environment.policyVersion, environmentDigest: environment.digest, instructions: environment.instructions, context: environment.context,
    required: items.filter(item => item.required), optional: items.filter(item => !item.required).sort((a, b) => Number(b.kind === 'term') - Number(a.kind === 'term') || (a.entryId === b.entryId ? 0 : a.entryId < b.entryId ? -1 : 1)),
    issues: environment.issues.filter(value => !value.cueIds.length || value.cueIds.some(id => selected.has(id))).map(value => ({ ...copy(value), cueIds: value.cueIds.filter(id => selected.has(id)) })) };
}

export function compileKnowledge(batch: BatchKnowledge, optionalCount = batch.optional.length): CompiledKnowledge {
  if (!Number.isInteger(optionalCount) || optionalCount < 0 || optionalCount > batch.optional.length) throw new TypeError('Invalid optional knowledge budget');
  return { policyVersion: batch.policyVersion, environmentDigest: batch.environmentDigest, instructions: batch.instructions, context: batch.context,
    items: copy([...batch.required, ...batch.optional.slice(0, optionalCount)]),
    issues: [...copy(batch.issues), ...batch.optional.slice(optionalCount).map(item => issue('budget_excluded', [item.entryId], [...item.applicableCueIds]))] };
}

/** A literal absence is only a review hint; never replace output or grant approval. */
export function checkRequiredTerms(compiled: CompiledKnowledge, outputs: Array<{ cueId: string; text: string }>): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  for (const item of compiled.items) if (item.kind === 'term' && item.required) {
    for (const output of outputs) if (item.applicableCueIds.includes(output.cueId)) {
      if (item.matches.some(match => match.cueId === output.cueId && !normalizeForMatching(output.text).includes(normalizeForMatching(match.target)))) issues.push(issue('required_term_suspect', [item.entryId], [output.cueId]));
    }
  }
  return compactIssues(issues);
}
