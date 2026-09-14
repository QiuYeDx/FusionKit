import type { ExportSelectionPreview, ExportSelectionRequest } from '../../../src/translation-knowledge/export-contract';
import type { EntityGroup, KnowledgeEntity, LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import type { Entry, KnowledgePackage, LanguagePair } from '../../../src/translation-knowledge/schemas';
import { ENTITY_ARRAYS, LIMITS } from '../../../src/translation-knowledge/schemas';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { validatePackage, type Diagnostic } from '../../../src/translation-knowledge/validation';

type Library = Pick<LibrarySnapshot, 'data' | 'approvals'>;
type Included = ExportSelectionPreview['included'][number];
type Exclusion = ExportSelectionPreview['excluded'][number]['reason'];
type CollectionUse = { explicit: boolean; readPairs: Set<string>; destination: boolean; viaIds: Set<string> };
const titleOf = (record: KnowledgeEntity) => 'title' in record ? record.title : record.name;
const languageKey = (pair: LanguagePair) => `${pair.source}\0${pair.target}`;
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Compute exactly what the user will share. This function neither writes nor mints
 * identities: the caller provides one export header and freezes the returned bytes.
 */
export function buildExportSelection(library: Library, options: ExportSelectionRequest, header: KnowledgePackage['package']): { data?: KnowledgePackage; preview: ExportSelectionPreview } {
  const preview: ExportSelectionPreview = {
    counts: { subjects: 0, collections: 0, sources: 0, entries: 0, styles: 0, recipes: 0, preferenceTemplates: 0 },
    included: [], excluded: [], collectionImpacts: [], sourceExcerpts: [], memoryExcerpts: [], errors: [], warnings: [],
  };
  const data: KnowledgePackage = { format: 'fusionkit.translation-knowledge', schemaVersion: 1, package: structuredClone(header), subjects: [], collections: [], sources: [], entries: [], styles: [], recipes: [], preferenceTemplates: [] };
  const records = new Map<string, { group: EntityGroup; record: KnowledgeEntity; path: string }>();
  for (const group of ENTITY_ARRAYS) library.data[group].forEach((record, index) => records.set(record.id, { group, record, path: `/${group}/${index}` }));
  const included = new Map<string, Included>();
  const includedVia = new Map<string, Set<string>>();
  const excluded = new Map<string, ExportSelectionPreview['excluded'][number]>();
  const collectionUses = new Map<string, CollectionUse>();
  const allEntriesByCollection = new Map<string, Entry[]>();
  for (const entry of library.data.entries) {
    const entries = allEntriesByCollection.get(entry.collectionId) ?? [];
    entries.push(entry); allEntriesByCollection.set(entry.collectionId, entries);
  }
  const diagnosticKeys = new Set<string>();
  const report = (warning: boolean, code: string, path: string, message: string) => {
    const key = `${warning}:${code}:${path}:${message}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    const list = warning ? preview.warnings : preview.errors;
    if (list.length < LIMITS.diagnostics) list.push({ code, path, message });
  };
  const error = (code: string, path: string, message: string) => report(false, code, path, message);
  const warning = (code: string, path: string, message: string) => report(true, code, path, message);
  const ref = (id: string, group: EntityGroup, path: string) => {
    const found = records.get(id);
    if (!found) error('REFERENCE_MISSING', path, `Referenced ${group} ID ${id} is absent from the library.`);
    else if (found.group !== group) error('REFERENCE_TYPE', path, `Expected ${group}, found ${found.group}.`);
    return found?.group === group ? found.record : undefined;
  };
  const add = (id: string, group: EntityGroup, reason: Included['reason'], viaIds: string[], path: string) => {
    const record = ref(id, group, path);
    if (!record) return;
    const current = included.get(id);
    if (current) {
      if (reason === 'selected' || (reason === 'dependency' && current.reason === 'destination')) current.reason = reason;
      viaIds.forEach(via => includedVia.get(id)!.add(via));
    } else {
      included.set(id, { id, group, title: titleOf(record), reason, viaIds: [] });
      includedVia.set(id, new Set(viaIds));
    }
  };
  const exclude = (record: KnowledgeEntity, reason: Exclusion) => {
    if (!excluded.has(record.id)) excluded.set(record.id, { id: record.id, title: titleOf(record), reason });
  };
  const validateSelection = (ids: string[], group: EntityGroup, path: string) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) error('EXPORT_DUPLICATE_SELECTION', `${path}/${index}`, 'Select each item only once.');
      seen.add(id);
      ref(id, group, `${path}/${index}`);
    });
  };
  validateSelection(options.collectionIds, 'collections', '/collectionIds');
  validateSelection(options.recipeIds, 'recipes', '/recipeIds');
  validateSelection(options.excludedSourceIds, 'sources', '/excludedSourceIds');
  if (header.purpose !== options.purpose) error('EXPORT_PURPOSE_MISMATCH', '/package/purpose', 'Export header and selection purposes must match.');

  if (options.purpose === 'backup') {
    // Backup is deliberately complete. Excluding sources would promise a privacy
    // choice that full backup cannot honor; use a share selection for that case.
    if (options.excludedSourceIds.length) error('EXPORT_BACKUP_SOURCE_EXCLUSION', '/excludedSourceIds', 'A complete backup cannot exclude sources; use share to remove sources and affected entries.');
    data.package = { ...structuredClone(library.data.package), ...structuredClone(header) };
    if (library.data.extensions) data.extensions = structuredClone(library.data.extensions);
    for (const group of ENTITY_ARRAYS) for (const record of library.data[group]) add(record.id, group, 'selected', [], records.get(record.id)!.path);
    for (const collection of library.data.collections) collectionUses.set(collection.id, { explicit: true, readPairs: new Set(), destination: false, viaIds: new Set() });
    warning('EXPORT_BACKUP_ALL_CONTENT', '', 'Backup includes every current record, including unreviewed and archived entries, reference translations and source excerpts.');
  } else {
    if (!options.collectionIds.length && !options.recipeIds.length) error('EXPORT_SELECTION_REQUIRED', '/collectionIds', 'Select at least one collection or recipe to share.');
    const sourceExclusions = new Set(options.excludedSourceIds);
    const entryExclusion = (entry: Entry): Exclusion | undefined => {
      if ([...entry.evidence.map(item => item.sourceId), ...entry.derivedFrom.map(item => item.evidenceSourceId)].some(id => sourceExclusions.has(id))) return 'source_excluded';
      const collection = records.get(entry.collectionId)?.record;
      const inactiveScope = entry.scope.requiredSubjects.some(binding => {
        const subject = records.get(binding.subjectId)?.record;
        return subject && 'archived' in subject && subject.archived;
      });
      if (!options.includeInactive && (['archived', 'rejected'].includes(entry.state) || (collection && 'archived' in collection && collection.archived) || inactiveScope)) return 'inactive';
      if (entry.kind === 'memory' && !options.includeMemories) return 'memory';
      if (!options.includeUnreviewed) {
        if (entry.state === 'candidate' || entry.state === 'needs_review') return 'unreviewed';
        const approval = library.approvals[entry.id];
        if (entry.state === 'ready' && (!approval || approval.revision !== entry.revision || approval.digest !== sha256Canonical(entry))) return 'unreviewed';
      }
      return undefined;
    };
    const inactiveDependency = (record: KnowledgeEntity, path: string) => {
      if ('archived' in record && record.archived && !options.includeInactive) {
        exclude(record, 'inactive');
        error('EXPORT_DEPENDENCY_FILTERED', path, `${titleOf(record)} is archived. Include inactive content or remove the collection/recipe that requires it.`);
      }
    };
    const aboutSubjects = (subjectIds: string[], viaId: string, path: string) => subjectIds.forEach((id, index) => {
      add(id, 'subjects', 'dependency', [viaId], `${path}/${index}`);
      const subject = records.get(id)?.record;
      // Descriptive associations are not applicability constraints.
      if (subject && 'archived' in subject && subject.archived) warning('EXPORT_ARCHIVED_METADATA', `${path}/${index}`, `Archived subject ${titleOf(subject)} is retained as descriptive metadata; it does not enable inactive entries.`);
    });
    const useCollection = (id: string, use: 'explicit' | 'read' | 'destination' | 'entry', viaIds: string[], path: string, pair?: LanguagePair) => {
      const record = ref(id, 'collections', path) as KnowledgePackage['collections'][number] | undefined;
      if (!record) return;
      let usage = collectionUses.get(id);
      if (!usage) { usage = { explicit: false, readPairs: new Set(), destination: false, viaIds: new Set() }; collectionUses.set(id, usage); }
      if (use === 'explicit') usage.explicit = true;
      if (use === 'read' && pair) usage.readPairs.add(languageKey(pair));
      if (use === 'destination') usage.destination = true;
      if (use !== 'entry') viaIds.forEach(via => usage!.viaIds.add(via));
      if (use === 'explicit' || use === 'read') inactiveDependency(record, path);
      if (use === 'destination' && record.archived) warning('EXPORT_ARCHIVED_DESTINATION', path, `Learning destination ${record.name} is archived. Its metadata is preserved; learning remains off until configured locally.`);
      add(id, 'collections', use === 'explicit' ? 'selected' : use === 'destination' ? 'destination' : 'dependency', viaIds, path);
      aboutSubjects(record.aboutSubjectIds, id, `${records.get(id)!.path}/aboutSubjectIds`);
    };
    const includeEntry = (entry: Entry, reason: Included['reason'], viaIds: string[], requiredPath?: string) => {
      const exclusion = entryExclusion(entry);
      if (exclusion) {
        exclude(entry, exclusion);
        if (requiredPath) error('EXPORT_DEPENDENCY_FILTERED', requiredPath, `Required rule ${entry.title} is excluded (${exclusion}). Adjust the sharing options/source exclusions or remove its recipe.`);
        return;
      }
      excluded.delete(entry.id);
      const path = records.get(entry.id)!.path;
      add(entry.id, 'entries', reason, viaIds, path);
      useCollection(entry.collectionId, 'entry', [entry.id], `${path}/collectionId`);
      aboutSubjects(entry.aboutSubjectIds, entry.id, `${path}/aboutSubjectIds`);
      entry.scope.requiredSubjects.forEach((binding, index) => add(binding.subjectId, 'subjects', 'dependency', [entry.id], `${path}/scope/requiredSubjects/${index}/subjectId`));
      entry.evidence.forEach((evidence, index) => add(evidence.sourceId, 'sources', 'dependency', [entry.id], `${path}/evidence/${index}/sourceId`));
      // Historical parents are optional provenance, never content dependencies.
      entry.derivedFrom.forEach((parent, index) => add(parent.evidenceSourceId, 'sources', 'dependency', [entry.id], `${path}/derivedFrom/${index}/evidenceSourceId`));
    };
    const requiredRules: { id: string; viaId: string; path: string }[] = [];
    options.collectionIds.forEach((id, index) => useCollection(id, 'explicit', [], `/collectionIds/${index}`));
    options.recipeIds.forEach((id, index) => {
      const recipe = ref(id, 'recipes', `/recipeIds/${index}`) as KnowledgePackage['recipes'][number] | undefined;
      if (!recipe) return;
      const path = records.get(id)!.path;
      inactiveDependency(recipe, `/recipeIds/${index}`);
      add(id, 'recipes', 'selected', [], path);
      recipe.readCollectionIds.forEach((collectionId, readIndex) => useCollection(collectionId, 'read', [id], `${path}/readCollectionIds/${readIndex}`, recipe.languagePair));
      if (recipe.suggestedDestinationCollectionId) useCollection(recipe.suggestedDestinationCollectionId, 'destination', [id], `${path}/suggestedDestinationCollectionId`);
      recipe.subjectSuggestions.forEach((binding, subjectIndex) => {
        add(binding.subjectId, 'subjects', 'dependency', [id], `${path}/subjectSuggestions/${subjectIndex}/subjectId`);
        const subject = records.get(binding.subjectId)?.record;
        if (subject && 'archived' in subject && subject.archived) warning('EXPORT_ARCHIVED_METADATA', `${path}/subjectSuggestions/${subjectIndex}/subjectId`, `Archived subject suggestion ${titleOf(subject)} is preserved as a suggestion, not a confirmed binding.`);
      });
      const styleRefs = [...(recipe.baseStyleId ? [{ id: recipe.baseStyleId, path: `${path}/baseStyleId` }] : []), ...recipe.modifierStyleIds.map((styleId, styleIndex) => ({ id: styleId, path: `${path}/modifierStyleIds/${styleIndex}` }))];
      for (const styleRef of styleRefs) {
        const style = ref(styleRef.id, 'styles', styleRef.path) as KnowledgePackage['styles'][number] | undefined;
        if (!style) continue;
        inactiveDependency(style, styleRef.path);
        add(style.id, 'styles', 'dependency', [recipe.id], styleRef.path);
        style.ruleEntryIds.forEach((ruleId, ruleIndex) => requiredRules.push({ id: ruleId, viaId: style.id, path: `${records.get(style.id)!.path}/ruleEntryIds/${ruleIndex}` }));
      }
    });
    for (const entry of library.data.entries) {
      const use = collectionUses.get(entry.collectionId);
      if (!use || (!use.explicit && !use.readPairs.size)) continue;
      if (!use.explicit && !use.readPairs.has(languageKey(entry.scope.languagePair))) { exclude(entry, 'language'); continue; }
      includeEntry(entry, use.explicit ? 'selected' : 'dependency', [entry.collectionId, ...use.viaIds]);
    }
    for (const requirement of requiredRules) {
      const rule = ref(requirement.id, 'entries', requirement.path) as Entry | undefined;
      if (!rule) continue;
      if (rule.kind !== 'rule') { error('STYLE_RULE_TYPE', requirement.path, 'A selected style references an entry that is not a rule.'); continue; }
      includeEntry(rule, 'dependency', [requirement.viaId], requirement.path);
    }
    if (library.data.extensions && Object.keys(library.data.extensions).length) warning('EXPORT_PACKAGE_METADATA_OMITTED', '/extensions', 'Library-wide package metadata is excluded from this share selection. Included entities retain their own extensions; complete backup retains library metadata.');
  }

  for (const group of ENTITY_ARRAYS) {
    const selected = library.data[group].filter(record => included.has(record.id));
    // Assign through the common union while retaining original entity field order/content.
    (data[group] as KnowledgeEntity[]) = structuredClone(selected);
    preview.counts[group] = selected.length;
    for (const record of selected) preview.included.push({ ...included.get(record.id)!, viaIds: [...includedVia.get(record.id)!] });
  }
  preview.excluded = [...excluded.values()];
  const outputEntriesByCollection = new Map<string, Entry[]>();
  const sourceEntryIds = new Map<string, Set<string>>();
  for (const entry of data.entries) {
    const entries = outputEntriesByCollection.get(entry.collectionId) ?? [];
    entries.push(entry); outputEntriesByCollection.set(entry.collectionId, entries);
    for (const sourceId of [...entry.evidence.map(item => item.sourceId), ...entry.derivedFrom.map(item => item.evidenceSourceId)]) {
      const ids = sourceEntryIds.get(sourceId) ?? new Set();
      ids.add(entry.id); sourceEntryIds.set(sourceId, ids);
    }
  }
  for (const collection of data.collections) {
    const use = collectionUses.get(collection.id)!;
    const allEntries = allEntriesByCollection.get(collection.id) ?? [];
    const outputEntries = outputEntriesByCollection.get(collection.id) ?? [];
    preview.collectionImpacts.push({ id: collection.id, name: collection.name, explicit: use.explicit, destinationOnly: use.destination && !use.explicit && !use.readPairs.size && !outputEntries.length, totalEntries: allEntries.length, includedEntries: outputEntries.length, excludedEntries: allEntries.length - outputEntries.length, memories: outputEntries.filter(entry => entry.kind === 'memory').length, viaIds: [...use.viaIds] });
  }
  preview.sourceExcerpts = data.sources.map(source => ({ id: source.id, title: source.title, kind: source.kind, excerpt: source.excerpt, ...(source.attribution ? { attribution: source.attribution } : {}), entryIds: [...(sourceEntryIds.get(source.id) ?? [])] }));
  preview.memoryExcerpts = data.entries.flatMap(entry => entry.kind === 'memory' ? [{ id: entry.id, title: entry.title, source: entry.payload.source, target: entry.payload.target }] : []);
  if (data.sources.some(source => source.kind === 'reviewed_subtitle')) warning('EXPORT_SUBTITLE_EXCERPTS', '/sources', 'Included sources contain reviewed subtitle excerpts, even if reference translation entries are excluded. Review their excerpts before sharing.');
  const checked = validatePackage(data);
  for (const item of checked.errors) error(item.code, item.path, item.message);
  for (const item of checked.warnings) warning(item.code, item.path, item.message);
  for (const item of exportPrivacyDiagnostics(data)) error(item.code, item.path, item.message);
  return { ...(preview.errors.length ? {} : { data }), preview };
}

/** Keep private values visible as located errors; never mutate a versioned entity. */
export function exportPrivacyDiagnostics(data: KnowledgePackage): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const visit = (value: unknown, path: string): void => {
    if (diagnostics.length >= LIMITS.diagnostics) return;
    if (typeof value === 'string') {
      const absolutePath = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|private|tmp|var|etc|Volumes|mnt|opt|root|Applications)\/)/.test(value) || /file:\/\//i.test(value);
      const credential = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i.test(value) || /[?&](?:api[_-]?key|access[_-]?token|token|secret|password)=\S+/i.test(value);
      if (absolutePath || credential) diagnostics.push({ code: 'EXPORT_PRIVATE_CONTENT', path, message: 'This field contains a local path or credential-like value. Exclude its source and affected entries or create a portable version before exporting.' });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}/${index}`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (diagnostics.length >= LIMITS.diagnostics) break;
      const itemPath = `${path}/${escapePointer(key)}`;
      if (/^(?:api[_-]?key|access[_-]?token|password|secret|authorization)$/i.test(key) && item) diagnostics.push({ code: 'EXPORT_PRIVATE_CONTENT', path: itemPath, message: 'Credential fields cannot be exported.' });
      else visit(item, itemPath);
    }
  };
  visit(data, '');
  return diagnostics;
}
