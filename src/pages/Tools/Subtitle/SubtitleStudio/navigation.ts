export type StudioNavigationView = "documents" | "transcription";

/** A view hint selects a workspace only; it never identifies or starts a task. */
export function studioNavigationPath(view: StudioNavigationView): string {
  return `/tools/subtitle/studio?view=${view}`;
}

/** Opens one document in the documents view; the library finds it first, so an id grants nothing. */
export function studioDocumentPath(documentId: string): string {
  return `/tools/subtitle/studio?${new URLSearchParams({ view: "documents", document: documentId }).toString()}`;
}

export function readStudioNavigationDocument(search: string): string | null {
  const values = new URLSearchParams(search).getAll("document");
  return values.length === 1 && values[0] && values[0].length <= 200 ? values[0] : null;
}

export function readStudioNavigationView(search: string): StudioNavigationView | null {
  const values = new URLSearchParams(search).getAll("view");
  return values.length === 1 && (values[0] === "documents" || values[0] === "transcription") ? values[0] : null;
}
