import type { z } from 'zod';
import { LIMITS } from '../../../src/subtitle-studio/domain';
import { summarizeDocument, type requestSchemas, type DocumentListSnapshot } from '../../../src/subtitle-studio/ipc-contract';
import { matchesLibraryQuery } from '../../../src/subtitle-studio/library-query';
import type { DocumentRepository } from './document-repository';

export function selectLibrary(snapshot: Awaited<ReturnType<DocumentRepository['listSnapshot']>>, request: z.infer<typeof requestSchemas.listDocuments>): DocumentListSnapshot {
  const documents = snapshot.records.map(({ snapshot: record, updatedAt }) => summarizeDocument(record.document, record.tasks, updatedAt)).filter(doc => matchesLibraryQuery(doc, request));
  documents.sort((a, b) => {
    let compared = 0;
    switch (request.sort ?? 'name-asc') {
      case 'name-asc': compared = a.origin.displayName.localeCompare(b.origin.displayName, undefined, { numeric: true, sensitivity: 'base' }); break;
      case 'name-desc': compared = b.origin.displayName.localeCompare(a.origin.displayName, undefined, { numeric: true, sensitivity: 'base' }); break;
      case 'cue-count-asc': compared = a.cueCount - b.cueCount; break;
      case 'cue-count-desc': compared = b.cueCount - a.cueCount; break;
      case 'recent': compared = (b.updatedAt ?? 0) - (a.updatedAt ?? 0); break;
      case 'oldest': compared = (a.updatedAt ?? 0) - (b.updatedAt ?? 0); break;
    }
    return compared || a.id.localeCompare(b.id);
  });
  return { documents: documents.slice(request.offset, request.offset + (request.pageSize ?? LIMITS.pageSize)), total: documents.length, allTotal: snapshot.documents.length,
    unavailableDocuments: snapshot.unavailableDocuments, unavailable: snapshot.unavailable, sequence: snapshot.sequence };
}
