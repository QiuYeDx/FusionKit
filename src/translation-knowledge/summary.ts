import type { Entry } from './schemas'

const NOTE_SUMMARY_CHARS = 120

/** One-line display text shared by the library page, Studio and the assistant. */
export function entrySummary(entry: Entry): string {
  if (entry.kind === 'term') return `${entry.payload.source} → ${entry.payload.target}`
  const line = entry.payload.text.trim().split(/\r?\n/u, 1)[0]
  return line.length > NOTE_SUMMARY_CHARS ? `${line.slice(0, NOTE_SUMMARY_CHARS)}…` : line
}
