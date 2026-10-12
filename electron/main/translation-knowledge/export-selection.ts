import type { ExportSelectionRequest } from '../../../src/translation-knowledge/export-contract';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { SCHEMA_VERSION, type KnowledgePackage } from '../../../src/translation-knowledge/schemas';
import { validatePackage, type Diagnostic } from '../../../src/translation-knowledge/validation';
import { diagnostic, KnowledgeServiceError } from './errors';

/** The selected collections, their entries and (optionally) presets that only use them. */
export function buildExportPackage(library: Pick<LibrarySnapshot, 'data'>, request: ExportSelectionRequest, header: KnowledgePackage['package']): KnowledgePackage {
  const selected = new Set(request.collectionIds);
  if (!selected.size) throw new KnowledgeServiceError('invalid_input', [diagnostic('EXPORT_SELECTION_REQUIRED', 'Select at least one collection to export.', '/collectionIds')]);
  if (selected.size !== request.collectionIds.length) throw new KnowledgeServiceError('invalid_input', [diagnostic('DUPLICATE_COLLECTION', 'Select each collection once.', '/collectionIds')]);
  const collections = library.data.collections.filter(item => selected.has(item.id));
  if (collections.length !== selected.size) throw new KnowledgeServiceError('not_found');
  const data: KnowledgePackage = {
    format: 'fusionkit.translation-knowledge', schemaVersion: SCHEMA_VERSION, package: structuredClone(header),
    collections: structuredClone(collections),
    entries: structuredClone(library.data.entries.filter(entry => selected.has(entry.collectionId) && (request.includeDisabled || entry.enabled))),
    presets: request.includePresets ? structuredClone(library.data.presets.filter(preset => preset.collectionIds.length > 0 && preset.collectionIds.every(id => selected.has(id)))) : [],
  };
  const checked = validatePackage(data);
  if (!checked.valid) throw new KnowledgeServiceError('invalid_input', checked.errors);
  return data;
}

/** Local paths and credential-like text. Reported so the user can decide; never scrubbed silently. */
export function privacyWarnings(data: KnowledgePackage): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const visit = (value: unknown, location: string): void => {
    if (diagnostics.length >= 100) return;
    if (typeof value === 'string') {
      const absolutePath = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|private|tmp|var|etc|Volumes|mnt|opt|root|Applications)\/)/.test(value) || /file:\/\//i.test(value);
      const credential = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{12,})/i.test(value) || /[?&](?:api[_-]?key|access[_-]?token|token|secret|password)=\S+/i.test(value);
      if (absolutePath || credential) diagnostics.push(diagnostic('EXPORT_PRIVATE_CONTENT', 'This field looks like a local path or a credential. Check it before sharing the file.', location));
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${location}/${index}`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${location}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  };
  visit(data, '');
  return diagnostics;
}
