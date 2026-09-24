import type { Entry, KnowledgePackage } from './schemas';

/** Shared by the review UI and the service; selection never grants authority. */
export function requiresIndividualReview(entry: Entry): boolean {
  return entry.kind === 'context' ? entry.payload.core
    : (entry.kind === 'term' || entry.kind === 'rule') && entry.payload.strength === 'required';
}

export function hasArchivedReviewDependency(entry: Entry, data: KnowledgePackage): boolean {
  return data.collections.some(item => item.id === entry.collectionId && item.archived)
    || data.subjects.some(item => item.archived && entry.scope.requiredSubjects.some(subject => subject.subjectId === item.id));
}
