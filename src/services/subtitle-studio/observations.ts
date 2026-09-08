import type { DocumentListSnapshot, DocumentSummary, StudioEvent } from '../../subtitle-studio/ipc-contract';

// Keep observations for every document, including off-page entities and permanent deletion tombstones.
export class StudioObservations {
  private readonly events = new Map<string, StudioEvent>();
  private readonly revisions = new Map<string, number>();
  private snapshotSequence = -1;
  observe(event: StudioEvent): boolean {
    const previous = this.events.get(event.documentId);
    if (event.revision < (this.revisions.get(event.documentId) ?? 0) || previous && (previous.deleted || previous.sequence >= event.sequence || previous.revision > event.revision)) return false;
    this.events.set(event.documentId, event);
    this.revisions.set(event.documentId, event.revision);
    return true;
  }
  acceptsDocument(document: Pick<DocumentSummary, 'id' | 'revision'>): boolean {
    const event = this.events.get(document.id);
    return !event?.deleted && document.revision >= (this.revisions.get(document.id) ?? 0);
  }
  acceptSnapshot(snapshot: DocumentListSnapshot): boolean {
    if (snapshot.sequence < this.snapshotSequence) return false;
    for (const event of this.events.values()) if (event.sequence > snapshot.sequence) return false;
    if (snapshot.documents.some(document => !this.acceptsDocument(document))) return false;
    for (const document of snapshot.documents) this.revisions.set(document.id, document.revision);
    this.snapshotSequence = snapshot.sequence;
    return true;
  }
}
