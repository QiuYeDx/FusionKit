import type { DocumentSummary } from './ipc-contract';

type LibraryFilter = { query?: string; format?: string; status?: string };

// Keep selection scope and the main-process result set on the same predicate.
export function matchesLibraryQuery(doc: DocumentSummary, request: LibraryFilter): boolean {
  const query = request.query?.trim().toLocaleLowerCase() ?? '';
  if (query && !doc.origin.displayName.toLocaleLowerCase().includes(query)) return false;
  if (request.format && request.format !== 'all' && doc.origin.format !== request.format) return false;
  if (request.status === 'untranslated' && doc.translationStatus !== 'none') return false;
  if (request.status === 'translated' && doc.translationStatus === 'none') return false;
  if (request.status === 'active' && (!doc.task || !['queued', 'running'].includes(doc.task.status))) return false;
  if (request.status === 'attention' && !doc.diagnostics.length && (!doc.task || !['failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))) return false;
  return true;
}
