import { type TextSubtitleDocument } from '../domain';
import { parseAssStructure } from './ass';
import { parseVttStructure } from './vtt';
import { bindPreservedBodies } from './preserved';

export type PreservedFormat = 'vtt' | 'ass' | 'ssa';
export const isPreservedFormat = (format: string): format is PreservedFormat => format === 'vtt' || format === 'ass' || format === 'ssa';

export function preservedStructure(format: PreservedFormat, raw: string) {
  return format === 'vtt' ? parseVttStructure(raw) : parseAssStructure(raw, format);
}

export function preservedBodies(doc: TextSubtitleDocument) {
  if (!isPreservedFormat(doc.origin.format)) return undefined;
  return bindPreservedBodies(doc, preservedStructure(doc.origin.format, doc.preservation.rawText));
}
