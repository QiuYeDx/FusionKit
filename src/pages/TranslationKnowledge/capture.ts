import type { LanguagePair } from '@/translation-knowledge/schemas';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { buildKnowledgeProposal, type KnowledgeProposal, type ProposalBasis, type ProposalInput } from '@/translation-knowledge/proposal';

/** Wordings offered for keeping at once, such as the ones an applied revision settled. */
export const CAPTURE_ROW_LIMIT = 50;

export interface CaptureRow { key: string; source: string; target: string; note?: string; selected: boolean }
/** Where the rows go: an existing collection, or a new one by name. */
export type CaptureDestination = { collectionId: string } | { newCollectionName: string };
export type CaptureRowStatus =
  | { kind: 'new' }
  | { kind: 'exists' }
  | { kind: 'conflict'; collectionName: string; target: string }
  | { kind: 'invalid'; reason: string };

const NEW_COLLECTION = 'capture';

function input(rows: readonly CaptureRow[], destination: CaptureDestination, pair: LanguagePair, basis: ProposalBasis, evidence?: string): ProposalInput {
  const collection = 'collectionId' in destination ? { id: destination.collectionId } : { ref: NEW_COLLECTION };
  return {
    languagePair: pair,
    ...('newCollectionName' in destination ? { collections: [{ ref: NEW_COLLECTION, name: destination.newCollectionName, languagePair: pair }] } : {}),
    entries: rows.map(row => ({ action: 'create' as const, collection, kind: 'term' as const, source: row.source, target: row.target,
      ...(row.note ? { note: row.note } : {}), basis, evidence: evidence?.trim() || `${row.source.trim()} → ${row.target.trim()}` })),
  };
}

/** Each row as saving it would treat it: new, already in that collection, or differing from another collection. */
export function captureStatuses(rows: readonly CaptureRow[], snapshot: LibrarySnapshot, destination: CaptureDestination, pair: LanguagePair): CaptureRowStatus[] {
  if (!rows.length) return [];
  const proposal = buildKnowledgeProposal(input(rows, destination, pair, 'user_revision'), snapshot, { newId: () => crypto.randomUUID() });
  const entries = proposal.items.filter(item => item.group === 'entries');
  return rows.map((_, index) => {
    const item = entries[index];
    if (!item || item.status === 'invalid') return { kind: 'invalid', reason: item?.reason ?? 'invalid' };
    if (item.status === 'exists') return { kind: 'exists' };
    const conflict = item.warnings.find(warning => warning.code === 'term_conflict');
    return conflict ? { kind: 'conflict', collectionName: conflict.collectionName ?? '', target: conflict.target ?? '' } : { kind: 'new' };
  });
}

/**
 * The proposal for the chosen rows. `ids` keeps the identities of an earlier attempt, so a retry
 * after an uncertain result reuses them instead of writing a second copy.
 */
export function captureProposal(rows: readonly CaptureRow[], snapshot: LibrarySnapshot, destination: CaptureDestination, pair: LanguagePair,
  options: { basis?: ProposalBasis; evidence?: string; ids?: Record<string, string>; sourceTitles?: Partial<Record<ProposalBasis, string>> } = {}): KnowledgeProposal {
  return buildKnowledgeProposal(input(rows.filter(row => row.selected), destination, pair, options.basis ?? 'user_revision', options.evidence), snapshot,
    { ids: options.ids, sourceTitles: options.sourceTitles });
}

/** Rows from suggested wordings: trimmed, de-duplicated, at most CAPTURE_ROW_LIMIT, and chosen unless already kept. */
export function captureRows(wordings: readonly { source: string; target: string; note?: string }[]): CaptureRow[] {
  const seen = new Set<string>();
  return wordings.flatMap((wording, index) => {
    const source = wording.source.trim(), target = wording.target.trim();
    const key = JSON.stringify([source.normalize('NFC'), target.normalize('NFC')]);
    if (!source || !target || seen.has(key)) return [];
    seen.add(key);
    return [{ key: `row-${index}`, source, target, ...(wording.note ? { note: wording.note } : {}), selected: true }];
  }).slice(0, CAPTURE_ROW_LIMIT);
}
