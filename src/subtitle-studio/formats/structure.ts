import { type TextSubtitleDocument } from '../domain';
import { parseAssStructure } from './ass';
import { parseVttStructure } from './vtt';
import { bindPreservedBodies } from './preserved';

export function preservedStructure(format: 'vtt' | 'ass', raw: string) {
  return format === 'vtt' ? parseVttStructure(raw) : parseAssStructure(raw);
}

export function preservedBodies(doc: TextSubtitleDocument) {
  if (doc.origin.format !== 'vtt' && doc.origin.format !== 'ass') return undefined;
  return bindPreservedBodies(doc, preservedStructure(doc.origin.format, doc.preservation.rawText));
}
