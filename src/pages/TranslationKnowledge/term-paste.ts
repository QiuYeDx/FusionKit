import type { Entry, TermEntry } from "@/translation-knowledge/schemas";
export type PastedTerm = { source: string; target: string; note: string };
export type PasteProblem = "empty" | "limit" | "format" | "columns";
export const MAX_PASTED_TERMS = 500;

/** CSV quoting also works with table TSV. Never split words on ordinary spaces. */
export function parseTermPaste(text: string, delimiter: "auto" | "tab" | "comma" = "auto", skipHeader = false):
  { ok: true; rows: PastedTerm[] } | { ok: false; problem: PasteProblem } {
  if (!text.trim()) return { ok: false, problem: "empty" };
  if (new TextEncoder().encode(text).length > 1024 * 1024) return { ok: false, problem: "limit" };
  const input = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const sep = delimiter === "tab" ? "\t" : delimiter === "comma" ? "," : input.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const finishField = () => { row.push(field.trim()); field = ""; closed = false; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === sep) finishField();
    else if (char === "\n") finishRow();
    else if (char === '"' && field.length === 0 && !closed) quoted = true;
    else if (char === '"' || closed) return { ok: false, problem: "format" };
    else field += char;
    if (rows.length > MAX_PASTED_TERMS + 1) return { ok: false, problem: "limit" };
  }
  if (quoted) return { ok: false, problem: "format" };
  if (field.length || row.length || closed) finishRow();
  // A terminal line break is fine; blank data lines stay visible as invalid rows.
  if (skipHeader) rows.shift();
  if (!rows.length) return { ok: false, problem: "empty" };
  if (rows.length > MAX_PASTED_TERMS) return { ok: false, problem: "limit" };
  if (rows.some(value => value.length < 2 || value.length > 3)) return { ok: false, problem: "columns" };
  return { ok: true, rows: rows.map(([source, target, note = ""]) => ({ source, target, note })) };
}

export function pastedTermProblem(row: PastedTerm): "required" | "limit" | null {
  if (!row.source.trim() || !row.target.trim()) return "required";
  return [row.source, row.target, row.note].some(value => new TextEncoder().encode(value).length > 32 * 1024) ? "limit" : null;
}

export type PasteStatus = "new" | "same" | "conflict" | "invalid" | "repeated";
export interface ClassifiedPaste { row: PastedTerm; status: PasteStatus; existing?: TermEntry }
const pasteKey = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();

/** Each pasted row against the collection: new, already saved as is, or a different translation of a saved source. */
export function classifyPaste(entries: readonly Entry[], collectionId: string, rows: readonly PastedTerm[]): ClassifiedPaste[] {
  const terms = entries.filter((entry): entry is TermEntry => entry.kind === "term" && entry.collectionId === collectionId);
  const seen = new Set<string>();
  return rows.map(row => {
    if (pastedTermProblem(row)) return { row, status: "invalid" };
    const key = pasteKey(row.source);
    if (seen.has(key)) return { row, status: "repeated" };
    seen.add(key);
    const existing = terms.find(entry => [entry.payload.source, ...entry.payload.aliases].some(value => pasteKey(value) === key));
    if (!existing) return { row, status: "new" };
    return { row, status: pasteKey(existing.payload.target) === pasteKey(row.target) ? "same" : "conflict", existing };
  });
}
