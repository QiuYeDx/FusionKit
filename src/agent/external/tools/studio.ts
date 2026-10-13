import type { DocumentPage, DocumentSummary, StudioResult } from "@/subtitle-studio/ipc-contract";
import { cueTextProblem, normalizeCueText, type CueTextProblem } from "@/subtitle-studio/cue-edit-contract";
import type { SubtitleText } from "@/subtitle-studio/domain";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";

export function studioApi() {
  if (typeof window === "undefined" || !window.subtitleStudio) throw new ExternalToolError("subtitle_studio_unavailable");
  return window.subtitleStudio;
}

/** Studio errors keep their own stable codes (revision_conflict, access_denied...). */
export function unwrapStudio<T>(result: StudioResult<T>): T {
  if (!result.ok) throw new ExternalToolError(result.error);
  return result.value;
}

export const bounded = (value: string, length = 255) => value.slice(0, length);

/** Last revision seen per document, so a read does not have to search the library each time. */
const knownRevisions = new Map<string, number>();
export function rememberRevision(summary: Pick<DocumentSummary, "id" | "revision">): void {
  knownRevisions.set(summary.id, summary.revision);
}

/**
 * Finds a document in the library. Listing it also lets this window open it:
 * Studio only serves documents a window has listed.
 */
export async function findDocument(documentId: string, ctx: ExternalToolContext): Promise<DocumentSummary> {
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const snapshot = unwrapStudio(await studioApi().listDocuments({ offset, pageSize }));
    checkActive(ctx);
    snapshot.documents.forEach(rememberRevision);
    const found = snapshot.documents.find(document => document.id === documentId);
    if (found) return found;
    if (!snapshot.documents.length || offset + snapshot.documents.length >= snapshot.total) throw new ExternalToolError("document_not_found");
  }
}

const retryable = (error: unknown) => error instanceof ExternalToolError && (error.code === "access_denied" || error.code === "revision_conflict");

/** One page of cues at the document's current revision, whichever revision this window knew. */
export async function readCurrentPage(documentId: string, offset: number, ctx: ExternalToolContext): Promise<DocumentPage> {
  const read = (revision: number) => studioApi().readDocumentPage({ documentId, revision, offset }).then(unwrapStudio);
  const known = knownRevisions.get(documentId);
  if (known !== undefined) {
    try { const page = await read(known); checkActive(ctx); return page; }
    catch (error) { if (!retryable(error)) throw error; }
  }
  const summary = await findDocument(documentId, ctx);
  const page = await read(summary.revision);
  checkActive(ctx);
  rememberRevision(page.summary);
  return page;
}

/**
 * A page at exactly the revision the agent named: a newer document answers
 * revision_conflict with its current revision, so the agent rereads first.
 */
export async function readPageAt(documentId: string, revision: number, ctx: ExternalToolContext): Promise<DocumentPage> {
  const read = () => studioApi().readDocumentPage({ documentId, revision, offset: 0 }).then(unwrapStudio);
  try { return await read(); }
  catch (error) {
    if (!retryable(error)) throw error;
    const summary = await findDocument(documentId, ctx);
    if (summary.revision !== revision) throw new ExternalToolError("revision_conflict", { currentRevision: summary.revision });
    return read();
  }
}

/** Re-raises revision_conflict with the revision to retry with. */
export async function withCurrentRevision<T>(documentId: string, ctx: ExternalToolContext, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ExternalToolError && error.code === "revision_conflict" && error.detail?.currentRevision === undefined) {
      const summary = await findDocument(documentId, ctx).catch(() => undefined);
      throw new ExternalToolError("revision_conflict", summary ? { currentRevision: summary.revision } : undefined);
    }
    throw error;
  }
}

/** Text an agent wrote, as Studio stores it, or why it cannot be stored. */
export function agentText(value: string): { text: SubtitleText } | { problem: CueTextProblem } {
  const plain = normalizeCueText(value);
  const problem = cueTextProblem(plain);
  return problem ? { problem } : { text: { plain, spans: [{ text: plain, marks: [] }] } };
}

/** Test reset. */
export function forgetKnownRevisions(): void { knownRevisions.clear(); }
