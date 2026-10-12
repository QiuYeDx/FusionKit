import type { LibrarySnapshot } from './ipc-contract';
import type { Entry } from './schemas';
import { sha256Canonical } from './canonicalize';
import { MATCH_POLICY_VERSION, matchLiteral, normalizeForMatching } from './matching';
import { knowledgeSelectionSchema, normalizeKnowledgeSelection, type KnowledgeSelection, type KnowledgeCue, type KnowledgeEnvironment, type KnowledgeIssue, type CompiledKnowledgeItem, type BatchKnowledge, type CompiledKnowledge } from './execution-contract';

export const KNOWLEDGE_EXECUTION_POLICY = `fktk-execution/4;${MATCH_POLICY_VERSION};term-context-rule` as const;
/** Preview work is bounded before serialization. Exceeding any budget blocks the
 * entire environment; required knowledge is never truncated. */
export const KNOWLEDGE_EXECUTION_LIMITS = Object.freeze({
  entries: 2000, termsAndRules: 500, termVariants: 128, matches: 5000,
  scanBytes: 8 * 1024 * 1024, conflictComparisons: 1_000_000, diagnostics: 5000,
});
const copy = <T>(value: T): T => structuredClone(value);
const issue = (code: KnowledgeIssue['code'], entryIds: string[] = [], cueIds: string[] = [], severity: KnowledgeIssue['severity'] = 'warning'): KnowledgeIssue => ({ code, severity, entryIds, cueIds });
const samePair = (left: { source: string; target: string }, right: { source: string; target: string }) => left.source === right.source && left.target === right.target;
const unique = <T>(values: T[]) => [...new Set(values)];
/** Terms other than "preferred" and notes marked required always reach the model. */
export const isRequiredEntry = (entry: Entry) => entry.kind === 'term' ? entry.payload.strength !== 'preferred' : entry.payload.required;

/** Pure resolution. Only the main process supplies the locally verified library. */
export function resolveEnvironment(library: Pick<LibrarySnapshot, 'generation' | 'data'>, input: KnowledgeSelection, inputCues: KnowledgeCue[]): KnowledgeEnvironment {
  const parsed = knowledgeSelectionSchema.safeParse(input);
  if (!parsed.success) throw new TypeError('Invalid knowledge selection');
  if (!inputCues.length || inputCues.length > 20 || new Set(inputCues.map(cue => cue.id)).size !== inputCues.length || inputCues.some(cue => !cue.id || !cue.text || new TextEncoder().encode(cue.text).byteLength > 65536)) throw new TypeError('Invalid knowledge cues');
  const selection = normalizeKnowledgeSelection(parsed.data), cues = copy(inputCues);
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
  const selectedSet = new Set(selection.collectionIds), disabled = new Set(selection.disabledEntryIds);
  const collections = selection.collectionIds.flatMap(id => {
    const collection = library.data.collections.find(item => item.id === id);
    if (!collection) { add(issue('resource_missing', [], [], 'error')); return []; }
    if (collection.archived) add(issue('resource_archived', [], [], 'error'));
    if (!samePair(collection.languagePair, selection.languagePair)) add(issue('language_mismatch', [], [], 'error'));
    return [collection];
  });
  const usable = new Set(collections.filter(item => !item.archived && samePair(item.languagePair, selection.languagePair)).map(item => item.id));
  const entriesById = new Map(library.data.entries.map(item => [item.id, item]));
  for (const id of selection.disabledEntryIds) if (!entriesById.has(id)) add(issue('selection_invalid', [id], [], 'error'));
  const candidates = library.data.entries.filter(entry => selectedSet.has(entry.collectionId));
  const withinLimits = candidates.length <= KNOWLEDGE_EXECUTION_LIMITS.entries &&
    candidates.filter(entry => entry.kind === 'term' || entry.kind === 'rule').length <= KNOWLEDGE_EXECUTION_LIMITS.termsAndRules &&
    candidates.every(entry => entry.kind !== 'term' || entry.payload.aliases.length + 1 <= KNOWLEDGE_EXECUTION_LIMITS.termVariants);
  if (!withinLimits) limit();
  for (const cue of cues) if (cue.sourceLanguage !== selection.languagePair.source) add(issue('language_mismatch', [], [cue.id], 'error'));
  entries: for (const entry of (withinLimits ? [...candidates] : []).sort((a, b) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1)) {
    if (resourceExceeded) break;
    if (!usable.has(entry.collectionId) || !entry.enabled) continue;
    if (disabled.has(entry.id)) { add(issue('disabled', [entry.id])); continue; }
    const applicable: string[] = [], matches: CompiledKnowledgeItem['matches'] = [];
    for (const cue of cues) {
      if (resourceExceeded) break entries;
      if (cue.sourceLanguage !== selection.languagePair.source) continue;
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
    items.push({ entryId: entry.id, revision: entry.revision, digest: sha256Canonical(entry), kind: entry.kind,
      applicableCueIds: applicable, required: isRequiredEntry(entry), payload: copy(entry.payload),
      ...(entry.origin ? { origin: copy(entry.origin) } : {}), matches });
  }
  // Longest match wins: a match lying inside another term's longer match in the same cue belongs to
  // that term (零号ホロウ, not ホロウ). Such a cue keeps the shorter term only if it occurs elsewhere there.
  if (!resourceExceeded) {
    const byCue = new Map<string, { item: CompiledKnowledgeItem; match: CompiledKnowledgeItem['matches'][number] }[]>();
    for (const item of items) if (item.kind === 'term') for (const match of item.matches) {
      const list = byCue.get(match.cueId) ?? []; list.push({ item, match }); byCue.set(match.cueId, list);
    }
    const shadowed = new Set<CompiledKnowledgeItem['matches'][number]>();
    for (const list of byCue.values()) {
      list.sort((a, b) => a.match.start - b.match.start);
      for (const inner of list) for (const outer of list) {
        if (outer.match.start > inner.match.start) break;
        if (outer.item === inner.item || outer.match.end - outer.match.start <= inner.match.end - inner.match.start) continue;
        if (outer.match.end >= inner.match.end) { shadowed.add(inner.match); break; }
      }
    }
    for (const item of items) if (item.kind === 'term' && item.matches.some(match => shadowed.has(match))) {
      item.matches = item.matches.filter(match => !shadowed.has(match));
      item.applicableCueIds = item.applicableCueIds.filter(cueId => item.matches.some(match => match.cueId === cueId));
    }
  }
  // Conflicts are local to actual overlapping matches, never collection order.
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
  const terms = resourceExceeded ? [] : items.filter(item => item.kind === 'term');
  conflicts: for (let i = 0; i < terms.length; i++) for (let j = i + 1; j < terms.length; j++) {
    if (resourceExceeded) break conflicts;
    const left = terms[i], right = terms[j];
    const entryIds = [left.entryId, right.entryId];
    if (!compare(entryIds)) break conflicts;
    for (const cueId of left.applicableCueIds.filter(id => right.applicableCueIds.includes(id))) {
      let conflict = false;
      if (!compare(entryIds)) break conflicts;
      const leftMatches = left.matches.filter(match => match.cueId === cueId), rightMatches = right.matches.filter(match => match.cueId === cueId);
      pair: for (const a of leftMatches) for (const b of rightMatches) {
        if (!compare(entryIds)) break conflicts;
        if (a.start >= b.end || b.start >= a.end) continue;
        const aTarget = normalizedTarget(a.target, left.entryId), bTarget = normalizedTarget(b.target, right.entryId);
        if (resourceExceeded) break conflicts;
        if (aTarget !== bTarget) { conflict = true; break pair; }
      }
      if (!conflict) continue;
      add(issue('term_conflict', entryIds, [cueId], left.required && right.required ? 'error' : 'warning'));
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
  const base = { policyVersion: KNOWLEDGE_EXECUTION_POLICY, generation: library.generation, sourceDigest: sha256Canonical(cues), configDigest: sha256Canonical(selection),
    selection: copy(selection), cues, instructions: selection.instructions ?? '', context: selection.context ?? '',
    items: items.filter(item => item.applicableCueIds.length), issues: compactIssues(issues),
    collections: collections.map(({ id, name }) => ({ id, name })) };
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

/** A literal absence is only a review hint; never replace output. */
export function checkRequiredTerms(compiled: CompiledKnowledge, outputs: Array<{ cueId: string; text: string }>): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  for (const item of compiled.items) if (item.kind === 'term' && item.required) {
    for (const output of outputs) if (item.applicableCueIds.includes(output.cueId)) {
      if (item.matches.some(match => match.cueId === output.cueId && !normalizeForMatching(output.text).includes(normalizeForMatching(match.target)))) issues.push(issue('required_term_suspect', [item.entryId], [output.cueId]));
    }
  }
  return compactIssues(issues);
}
