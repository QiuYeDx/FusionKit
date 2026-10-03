export type StudioNavigationView = "documents" | "transcription";

/** A view hint selects a workspace only; it never identifies or starts a task. */
export function studioNavigationPath(view: StudioNavigationView): string {
  return `/tools/subtitle/studio?view=${view}`;
}

export function readStudioNavigationView(search: string): StudioNavigationView | null {
  const values = new URLSearchParams(search).getAll("view");
  return values.length === 1 && (values[0] === "documents" || values[0] === "transcription") ? values[0] : null;
}
