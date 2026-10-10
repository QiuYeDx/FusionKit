import type { SubtitleText } from '@/subtitle-studio/domain';
import { CUE_EDIT_LIMIT, editedText, type CueEditOperation } from '@/subtitle-studio/cue-edit-contract';
import { fold, type ConsistencyDocument, type ConsistencyGroup, type ConsistencyResult } from '@/subtitle-studio/consistency-contract';

/** What the user chose for one group in the check window. */
export type GroupChoice = {
  /** Unify this group. */
  apply: boolean;
  /** The translation every place should use; empty when the group has none to unify. */
  standard: string;
  /** Also unify how the source writes the name. */
  fixSource: boolean;
  /** The source spelling to unify to, one of the group's spellings. */
  sourceStandard: string;
  /** Keep "source → standard" in translation materials afterwards. */
  keep: boolean;
};
/** The current texts of one cue, read at the checked revision. */
export type CueTexts = { source: SubtitleText; target?: SubtitleText };
export type DocumentEdit = { document: ConsistencyDocument; operation: CueEditOperation; count: number };
export type EditPlan = { edits: DocumentEdit[]; changedCues: number; tooMany: ConsistencyDocument[] };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Replaces every occurrence, ignoring case, as the check counted them. When the new wording
 * contains the old one (ハト → シロバト), places already written the new way are left alone.
 */
export function replaceWording(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  if (fold(to) === fold(from) || !fold(to).includes(fold(from))) return text.replace(new RegExp(escape(from), 'giu'), () => to);
  return text.replace(new RegExp(`(${escape(to)})|${escape(from)}`, 'giu'), (match, kept: string | undefined) => kept ? match : to);
}
export const cueKey = (documentId: string, cueId: string) => `${documentId}\u0000${cueId}`;

/** The group's translations that can be unified by replacement. */
const translations = (group: ConsistencyGroup) => group.variants.filter(variant => variant.text);
/** Whether the group has a translation to unify, or only source spellings. */
export const hasTranslations = (group: ConsistencyGroup) => translations(group).length > 0;
export const hasSpellings = (group: ConsistencyGroup) => group.spellings.length > 1;

/**
 * The default choice for a group: unify translations to the recommendation and leave the source
 * alone. A group whose only difference is the source spelling is left for the user to pick: its
 * own checkbox then unifies the source to the most common spelling.
 */
export function defaultChoice(group: ConsistencyGroup): GroupChoice {
  const fixable = translations(group).some(variant => variant.text !== group.recommended);
  return { apply: fixable, standard: group.recommended ?? translations(group)[0]?.text ?? '', fixSource: !hasTranslations(group) && hasSpellings(group),
    sourceStandard: group.spellings[0]?.text ?? group.source, keep: hasTranslations(group) && !group.knowledgeTarget };
}

/** Places a group cannot fix by replacement: lines whose translation lacks the materials' wording entirely. */
export function unfixablePlaces(group: ConsistencyGroup) {
  return group.variants.filter(variant => !variant.text).flatMap(variant => variant.occurrences);
}

/** The cues unifying a group would change (before combining with other groups). */
export function groupChanges(group: ConsistencyGroup, choice: GroupChoice): Set<string> {
  const cues = new Set<string>();
  if (!choice.apply) return cues;
  const standard = choice.standard.trim();
  if (standard) for (const variant of translations(group)) if (variant.text !== standard) variant.occurrences.forEach(place => cues.add(cueKey(place.documentId, place.cueId)));
  if (choice.fixSource && choice.sourceStandard) for (const spelling of group.spellings) if (fold(spelling.text) !== fold(choice.sourceStandard))
    spelling.occurrences.forEach(place => cues.add(cueKey(place.documentId, place.cueId)));
  return cues;
}
export const groupChangeCount = (group: ConsistencyGroup, choice: GroupChoice) => groupChanges(group, choice).size;

/**
 * One revise operation per document: other renderings replaced by the standard in translations,
 * and source spellings unified only where asked. A fixed source keeps its translation current.
 * Pure: `texts` holds every touched cue's texts as read at the checked revision.
 */
export function planConsistencyEdits(result: ConsistencyResult, choices: ReadonlyMap<string, GroupChoice>, texts: ReadonlyMap<string, CueTexts>): EditPlan {
  const sources = new Map<string, Map<string, string>>(), targets = new Map<string, Map<string, string>>();
  const at = (map: Map<string, Map<string, string>>, documentId: string) => map.get(documentId) ?? map.set(documentId, new Map()).get(documentId)!;
  for (const group of result.groups) {
    const choice = choices.get(group.id);
    if (!choice?.apply) continue;
    const standard = choice.standard.trim();
    if (standard) for (const variant of translations(group)) {
      if (variant.text === standard) continue;
      for (const place of variant.occurrences) {
        const current = texts.get(cueKey(place.documentId, place.cueId));
        if (!current?.target) continue;
        const pending = at(targets, place.documentId);
        const before = pending.get(place.cueId) ?? current.target.plain;
        const after = replaceWording(before, variant.text, standard);
        if (after !== before) pending.set(place.cueId, after);
      }
    }
    if (!choice.fixSource || !choice.sourceStandard) continue;
    for (const spelling of group.spellings) {
      if (fold(spelling.text) === fold(choice.sourceStandard)) continue;
      for (const place of spelling.occurrences) {
        const current = texts.get(cueKey(place.documentId, place.cueId));
        if (!current) continue;
        const pending = at(sources, place.documentId);
        const before = pending.get(place.cueId) ?? current.source.plain;
        const after = replaceWording(before, spelling.text, choice.sourceStandard);
        if (after !== before) pending.set(place.cueId, after);
      }
    }
  }
  const edits: DocumentEdit[] = [], tooMany: ConsistencyDocument[] = [];
  for (const document of result.documents) {
    const sourceTexts = sources.get(document.documentId) ?? new Map<string, string>();
    const targetTexts = targets.get(document.documentId) ?? new Map<string, string>();
    const cueIds = new Set([...sourceTexts.keys(), ...targetTexts.keys()]);
    if (!cueIds.size) continue;
    if (cueIds.size > CUE_EDIT_LIMIT) { tooMany.push(document); continue; }
    const revisedSources: Record<string, SubtitleText> = {}, revisedTargets: Record<string, SubtitleText> = {};
    for (const cueId of cueIds) {
      const current = texts.get(cueKey(document.documentId, cueId))!;
      const source = sourceTexts.get(cueId);
      if (source !== undefined) revisedSources[cueId] = editedText(current.source, source);
      const target = targetTexts.get(cueId);
      if (target !== undefined) revisedTargets[cueId] = editedText(current.target, target);
      // A corrected source whose translation was right keeps that translation current.
      else if (source !== undefined && current.target) revisedTargets[cueId] = current.target;
    }
    const hasTargets = Object.keys(revisedTargets).length > 0 && !!document.trackId;
    edits.push({ document, count: cueIds.size,
      operation: { kind: 'revise', sources: revisedSources, ...(hasTargets ? { trackId: document.trackId!, targets: revisedTargets } : {}) } });
  }
  return { edits, changedCues: edits.reduce((sum, edit) => sum + edit.count, 0), tooMany };
}

/** "source → standard" for the groups the user wants kept in translation materials, under the source spelling kept. */
export function wordingsToKeep(result: ConsistencyResult, choices: ReadonlyMap<string, GroupChoice>): { source: string; target: string }[] {
  return result.groups.flatMap(group => {
    const choice = choices.get(group.id);
    const standard = choice?.standard.trim();
    const source = choice?.fixSource && choice.sourceStandard ? choice.sourceStandard : group.source;
    return choice?.apply && choice.keep && standard && hasTranslations(group) && standard !== group.knowledgeTarget ? [{ source, target: standard }] : [];
  });
}
