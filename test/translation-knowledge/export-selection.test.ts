import { describe, expect, it } from 'vitest';
import { buildExportSelection } from '../../electron/main/translation-knowledge/export-selection';
import { canonicalize, sha256Canonical } from '../../src/translation-knowledge/canonicalize';
import type { ExportSelectionRequest } from '../../src/translation-knowledge/export-contract';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';
import type { Entry, KnowledgePackage } from '../../src/translation-knowledge/schemas';
import { ENTITY_ARRAYS } from '../../src/translation-knowledge/schemas';
import { parseKnowledgePackage, validatePackage } from '../../src/translation-knowledge/validation';
import { knowledgeFixture } from './fixtures';

const id = (suffix: number) => `90000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
type Library = Pick<LibrarySnapshot, 'data' | 'approvals'>;
function approve(library: Library, entry: Entry) {
  library.approvals[entry.id] = { revision: entry.revision, digest: sha256Canonical(entry), method: 'human', approvedAt: '2026-09-14T00:00:00Z' };
}
function fixture(): Library {
  const library: Library = { data: knowledgeFixture(), approvals: {} };
  for (const entry of library.data.entries) { entry.state = 'ready'; approve(library, entry); }
  return library;
}
function options(library: Library, patch: Partial<ExportSelectionRequest> = {}): ExportSelectionRequest {
  return { generation: 1, purpose: 'share', collectionIds: [library.data.collections[0].id], recipeIds: [], includeMemories: false, includeUnreviewed: false, includeInactive: false, excludedSourceIds: [], ...patch };
}
function header(purpose: 'share' | 'backup' = 'share'): KnowledgePackage['package'] {
  return { id: id(999), revision: 1, name: 'Export selection test', description: '', purpose, createdAt: '2026-09-14T00:00:00Z', generator: { name: 'Fixture' } };
}
const build = (library: Library, patch: Partial<ExportSelectionRequest> = {}) => buildExportSelection(library, options(library, patch), header(patch.purpose));

describe('knowledge export selection', () => {
  it('defaults to exactly accepted ready entries and independently excludes memories', () => {
    const library = fixture();
    delete library.approvals[library.data.entries[0].id];
    library.approvals[library.data.entries[1].id].digest = '0'.repeat(64);
    const result = build(library);
    expect(result.preview.errors).toEqual([]);
    expect(result.data!.entries.map(entry => entry.kind)).toEqual(['expression', 'rule']);
    expect(result.preview.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: library.data.entries[0].id, reason: 'unreviewed' }),
      expect.objectContaining({ id: library.data.entries[1].id, reason: 'unreviewed' }),
      expect.objectContaining({ id: library.data.entries[3].id, reason: 'memory' }),
    ]));
    expect(result.data).not.toHaveProperty('approvals');
    expect(result.data!.styles).toEqual([]);
    expect(result.data!.recipes).toEqual([]);
  });

  it('retains explicit unreviewed/inactive states and requires separate memory opt-in', () => {
    const library = fixture();
    const states = ['candidate', 'needs_review', 'archived', 'ready', 'rejected'] as const;
    library.data.entries.forEach((entry, index) => { entry.state = states[index]; });
    library.approvals = {};
    expect(build(library).data!.entries).toEqual([]);
    const withoutMemories = build(library, { includeUnreviewed: true, includeInactive: true });
    expect(withoutMemories.data!.entries.map(entry => entry.state)).toEqual(['candidate', 'needs_review', 'archived', 'rejected']);
    const all = build(library, { includeUnreviewed: true, includeInactive: true, includeMemories: true });
    expect(all.data!.entries).toEqual(library.data.entries);
    expect(all.preview.memoryExcerpts).toEqual([{ id: library.data.entries[3].id, title: library.data.entries[3].title, source: 'We reached the checkpoint.', target: '我们到存档点了。' }]);
  });

  it('exports recipe dependencies once, filters implicit read collections by exact language, and reports additions', () => {
    const library = fixture();
    const foreign = structuredClone(library.data.entries[1]);
    foreign.id = id(1); foreign.scope.languagePair.source = 'ja';
    library.data.entries.push(foreign); approve(library, foreign);
    const recipe = library.data.recipes[0];
    const first = build(library, { collectionIds: [], recipeIds: [recipe.id] });
    expect(first.preview.errors).toEqual([]);
    expect(first.data!.entries.some(entry => entry.id === foreign.id)).toBe(false);
    expect(first.preview.excluded).toContainEqual({ id: foreign.id, title: foreign.title, reason: 'language' });
    expect(first.data!.styles).toEqual(library.data.styles);
    expect(first.preview.collectionImpacts[0]).toMatchObject({ explicit: false, destinationOnly: false, totalEntries: 6, includedEntries: 4, excludedEntries: 2, memories: 0, viaIds: [recipe.id] });
    const secondRecipe = structuredClone(recipe);
    secondRecipe.id = id(2); secondRecipe.languagePair.source = 'ja'; delete secondRecipe.baseStyleId;
    library.data.recipes.push(secondRecipe);
    const combined = build(library, { collectionIds: [], recipeIds: [recipe.id, secondRecipe.id] });
    expect(combined.preview.errors).toEqual([]);
    expect(combined.data!.entries.some(entry => entry.id === foreign.id)).toBe(true);
    expect(combined.data!.collections).toHaveLength(1);
    expect(combined.data!.styles).toHaveLength(1);
    const explicit = build(library, { recipeIds: [recipe.id] });
    expect(explicit.data!.entries.some(entry => entry.id === foreign.id)).toBe(true);
    expect(explicit.preview.collectionImpacts[0].explicit).toBe(true);
  });

  it.each(['candidate', 'archived'] as const)('blocks a selected recipe with a filtered %s rule until explicitly included', state => {
    const library = fixture();
    const rule = library.data.entries.find(entry => entry.kind === 'rule')!;
    rule.state = state;
    const patch = { collectionIds: [], recipeIds: [library.data.recipes[0].id] };
    const blocked = build(library, patch);
    expect(blocked.data).toBeUndefined();
    expect(blocked.preview.errors).toContainEqual(expect.objectContaining({ code: 'EXPORT_DEPENDENCY_FILTERED', path: '/styles/0/ruleEntryIds/0' }));
    const accepted = build(library, { ...patch, includeUnreviewed: state === 'candidate', includeInactive: state === 'archived' });
    expect(accepted.preview.errors).toEqual([]);
    expect(accepted.data!.entries.find(entry => entry.id === rule.id)).toEqual(rule);
  });

  it('includes a learning destination as metadata without its private entries or sources', () => {
    const library = fixture();
    const destination = structuredClone(library.data.collections[0]);
    destination.id = id(10); destination.name = 'Private learned translations'; destination.archived = true;
    library.data.collections.push(destination);
    const source = structuredClone(library.data.sources[0]);
    source.id = id(11); source.excerpt = 'PRIVATE DESTINATION EVIDENCE'; library.data.sources.push(source);
    const memory = structuredClone(library.data.entries[3]);
    memory.id = id(12); memory.collectionId = destination.id; memory.evidence = [{ sourceId: source.id, support: 'direct' }];
    library.data.entries.push(memory); approve(library, memory);
    library.data.recipes[0].learningSuggestion = 'save_reviewed';
    library.data.recipes[0].suggestedDestinationCollectionId = destination.id;
    const result = build(library, { collectionIds: [], recipeIds: [library.data.recipes[0].id], includeMemories: true });
    expect(result.preview.errors).toEqual([]);
    expect(result.data!.collections.find(collection => collection.id === destination.id)).toEqual(destination);
    expect(result.preview.collectionImpacts.find(impact => impact.id === destination.id)).toMatchObject({ destinationOnly: true, totalEntries: 1, includedEntries: 0, excludedEntries: 1, memories: 0 });
    expect(result.data!.sources.some(item => item.id === source.id)).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('PRIVATE DESTINATION EVIDENCE');
    const explicitlySelected = build(library, { collectionIds: [destination.id], recipeIds: [library.data.recipes[0].id], includeMemories: true, includeInactive: true });
    expect(explicitlySelected.preview.errors).toEqual([]);
    expect(explicitlySelected.preview.collectionImpacts.find(impact => impact.id === destination.id)).toMatchObject({ explicit: true, destinationOnly: false, includedEntries: 1, memories: 1 });
    expect(explicitlySelected.preview.included.find(item => item.id === destination.id)?.reason).toBe('selected');
    expect(explicitlySelected.data!.sources.some(item => item.id === source.id)).toBe(true);
  });

  it('includes historical evidence but does not pull in derived parents or their collections', () => {
    const library = fixture();
    const privateCollection = structuredClone(library.data.collections[0]); privateCollection.id = id(20);
    library.data.collections.push(privateCollection);
    const parent = library.data.entries[3]; parent.collectionId = privateCollection.id;
    const child = library.data.entries[0];
    child.derivedFrom = [{ entryId: parent.id, revision: parent.revision, digest: sha256Canonical(parent), evidenceSourceId: library.data.sources[2].id }];
    approve(library, child);
    const result = build(library);
    expect(result.preview.errors).toEqual([]);
    expect(result.data!.entries.some(entry => entry.id === parent.id)).toBe(false);
    expect(result.data!.collections.some(collection => collection.id === privateCollection.id)).toBe(false);
    expect(result.data!.sources).toContainEqual(library.data.sources[2]);
    expect(result.preview.sourceExcerpts.find(source => source.id === library.data.sources[2].id)?.entryIds).toEqual([child.id]);
    expect(result.preview.warnings.some(warning => warning.code === 'EXPORT_SUBTITLE_EXCERPTS')).toBe(true);
    expect(result.preview.memoryExcerpts).toEqual([]);
    const withoutHistoricalEvidence = build(library, { excludedSourceIds: [library.data.sources[2].id] });
    expect(withoutHistoricalEvidence.preview.errors).toEqual([]);
    expect(withoutHistoricalEvidence.data!.entries.some(entry => entry.id === child.id)).toBe(false);
    expect(withoutHistoricalEvidence.preview.excluded).toContainEqual({ id: child.id, title: child.title, reason: 'source_excluded' });
  });

  it('keeps whole entries out when a source is excluded and blocks dependent recipes', () => {
    const library = fixture();
    const excludedSourceId = library.data.sources[0].id;
    // Even another remaining source does not authorize rewriting the old entry's evidence.
    library.data.entries[0].evidence.push({ sourceId: library.data.sources[1].id, support: 'inferred' }); approve(library, library.data.entries[0]);
    const result = build(library, { excludedSourceIds: [excludedSourceId] });
    expect(result.preview.errors).toEqual([]);
    expect(result.data!.entries.map(entry => entry.kind)).toEqual(['expression']);
    expect(result.data!.sources.map(source => source.id)).toEqual([library.data.sources[1].id]);
    expect(result.preview.excluded.filter(entry => entry.reason === 'source_excluded')).toHaveLength(3);
    const recipe = build(library, { recipeIds: [library.data.recipes[0].id], excludedSourceIds: [excludedSourceId] });
    expect(recipe.data).toBeUndefined();
    expect(recipe.preview.errors.some(error => error.code === 'EXPORT_DEPENDENCY_FILTERED')).toBe(true);
  });

  it('does not treat archived descriptive subjects as scope, while filtering actual archived scope', () => {
    const library = fixture();
    const term = library.data.entries[1];
    term.scope.requiredSubjects = []; approve(library, term);
    library.data.subjects[0].archived = true;
    const result = build(library);
    expect(result.preview.errors).toEqual([]);
    expect(result.data!.entries.map(entry => entry.id)).toEqual([term.id]);
    expect(result.data!.subjects.find(subject => subject.id === library.data.subjects[0].id)?.archived).toBe(true);
    expect(result.preview.warnings.some(warning => warning.code === 'EXPORT_ARCHIVED_METADATA')).toBe(true);
    library.data.collections[0].archived = true;
    expect(build(library).preview.errors.some(error => error.code === 'EXPORT_DEPENDENCY_FILTERED')).toBe(true);
    expect(build(library, { includeInactive: true }).preview.errors).toEqual([]);
  });

  it('reports every actual source excerpt, including subtitle evidence used without memory entries', () => {
    const library = fixture();
    const term = library.data.entries[1];
    term.evidence.push({ sourceId: library.data.sources[2].id, support: 'direct' }); approve(library, term);
    const result = build(library);
    expect(result.preview.sourceExcerpts).toHaveLength(result.data!.sources.length);
    expect(result.preview.sourceExcerpts.find(source => source.id === library.data.sources[2].id)).toMatchObject({ excerpt: library.data.sources[2].excerpt, attribution: library.data.sources[2].attribution, entryIds: [term.id] });
    expect(result.preview.memoryExcerpts).toEqual([]);
    expect(result.preview.warnings.some(warning => warning.code === 'EXPORT_SUBTITLE_EXCERPTS')).toBe(true);
  });

  it('backs up all five types, catalog states and unknown extensions independently of share filters', () => {
    const library = fixture();
    library.data.entries[0].state = 'candidate'; library.data.entries[1].state = 'archived';
    library.data.styles[0].archived = true;
    library.data.package.extensions = { 'org.example.header': { retained: true } };
    const result = build(library, { purpose: 'backup', collectionIds: [], recipeIds: [] });
    expect(result.preview.errors).toEqual([]);
    for (const group of ENTITY_ARRAYS) expect(result.data![group]).toEqual(library.data[group]);
    expect(result.data!.extensions).toEqual(library.data.extensions);
    expect(result.data!.package.extensions).toEqual(library.data.package.extensions);
    expect(result.preview.memoryExcerpts).toHaveLength(1);
    expect(result.preview.sourceExcerpts).toHaveLength(library.data.sources.length);
    expect(result.data).not.toHaveProperty('approvals');
    expect(build(library, { purpose: 'backup', excludedSourceIds: [library.data.sources[0].id] }).preview.errors.some(error => error.code === 'EXPORT_BACKUP_SOURCE_EXCLUSION')).toBe(true);
  });

  it('omits unrelated library metadata on share while preserving included entities byte-for-byte', () => {
    const library = fixture();
    library.data.extensions!['org.fusionkit.package-provenance'] = { packages: ['unrelated private package'] };
    library.data.entries[0].extensions = { 'org.example.entry': { retained: true } }; approve(library, library.data.entries[0]);
    const before = canonicalize(library);
    const request = options(library, { recipeIds: [library.data.recipes[0].id], includeMemories: true });
    const first = buildExportSelection(library, request, header());
    const second = buildExportSelection(library, request, header());
    expect(first.preview.errors).toEqual([]);
    expect(canonicalize(first)).toBe(canonicalize(second));
    expect(canonicalize(library)).toBe(before);
    expect(first.data!.extensions).toBeUndefined();
    for (const group of ENTITY_ARRAYS) for (const record of first.data![group]) expect(sha256Canonical(record)).toBe(sha256Canonical(library.data[group].find(original => original.id === record.id)));
    expect(parseKnowledgePackage(canonicalize(first.data)).data).toEqual(first.data);
    expect(validatePackage(first.data).valid).toBe(true);
    first.data!.entries[0].title = 'Output can be edited independently';
    expect(canonicalize(library)).toBe(before);
  });

  it('returns located privacy errors without silently modifying or dropping evidence', () => {
    const library = fixture();
    library.data.sources[0].excerpt = 'Local material /Users/privateuser/private.srt';
    const result = build(library);
    expect(result.data).toBeUndefined();
    expect(result.preview.errors).toContainEqual(expect.objectContaining({ code: 'EXPORT_PRIVATE_CONTENT', path: '/sources/0/excerpt' }));
    expect(result.preview.sourceExcerpts[0].excerpt).toBe(library.data.sources[0].excerpt);
    expect(build(library, { excludedSourceIds: [library.data.sources[0].id] }).data).toBeDefined();
    library.data.sources[0].excerpt = 'Portable evidence';
    library.data.entries[0].extensions = { 'org.example.secret': { access_token: 'private-value' } }; approve(library, library.data.entries[0]);
    expect(build(library).preview.errors).toContainEqual(expect.objectContaining({ code: 'EXPORT_PRIVATE_CONTENT', path: '/entries/0/extensions/org.example.secret/access_token' }));
  });

  it('rejects unknown/duplicate roots and returns missing-reference diagnostics', () => {
    const library = fixture();
    const invalid = build(library, { collectionIds: [library.data.collections[0].id, library.data.collections[0].id], recipeIds: [id(70)], excludedSourceIds: [id(71)] });
    expect(invalid.data).toBeUndefined();
    expect(invalid.preview.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EXPORT_DUPLICATE_SELECTION', path: '/collectionIds/1' }),
      expect.objectContaining({ code: 'REFERENCE_MISSING', path: '/recipeIds/0' }),
      expect.objectContaining({ code: 'REFERENCE_MISSING', path: '/excludedSourceIds/0' }),
    ]));
    library.data.sources.shift();
    expect(build(library).preview.errors.some(error => error.code === 'REFERENCE_MISSING' && error.path.includes('/evidence/'))).toBe(true);
    expect(build(library, { collectionIds: [] }).preview.errors.some(error => error.code === 'EXPORT_SELECTION_REQUIRED')).toBe(true);
  });
});
