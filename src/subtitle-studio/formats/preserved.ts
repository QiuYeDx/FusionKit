import { LIMITS, StudioError, type Diagnostic, type SubtitleText, type TextSubtitleDocument } from '../domain';

export type RawBodyMapping = { bodyStart: number; bodyEnd: number; starts: number[]; ends: number[]; plain: string };
export type PreservedBody = RawBodyMapping & {
  text: SubtitleText; safe: boolean; prefix: string; suffix: string;
  startMs: number; endMs: number; label?: string;
  positioning: boolean; effects: boolean; styled: boolean;
  initialMarks?: ('b' | 'i' | 'u')[];
};
export type FormatNode = { start: number; end: number; body?: PreservedBody; diagnostics: Diagnostic['code'][]; opaque?: boolean };
export type PreservedStructure = { nodes: FormatNode[] };
export type RawLine = { start: number; contentEnd: number; end: number; text: string };

export function rawLines(raw: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const match of raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    if (lines.length >= LIMITS.nodes) throw new StudioError('limit_exceeded');
    const text = match[0].replace(/(?:\r\n|\r|\n)$/, '');
    lines.push({ start: match.index!, contentEnd: match.index! + text.length, end: match.index! + match[0].length, text });
  }
  return lines;
}

export class BodyBuilder {
  readonly spans: SubtitleText['spans'] = [];
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  private length = 0;
  add(text: string, start: number, end: number, marks: SubtitleText['spans'][number]['marks']) {
    this.length += text.length;
    if (this.length > LIMITS.cueBytes) throw new StudioError('limit_exceeded');
    const previous = this.spans.at(-1);
    if (previous && previous.marks.join() === marks.join()) previous.text += text;
    else this.spans.push({ text, marks: [...marks] });
    for (let i = 0; i < text.length; i++) { this.starts.push(start); this.ends.push(end); }
  }
  text(): SubtitleText {
    const plain = this.spans.map(span => span.text).join('');
    // Measure complete Unicode, not individual UTF-16 units: a surrogate pair
    // is four UTF-8 bytes, while separately encoding each half would count six.
    if (new TextEncoder().encode(plain).length > LIMITS.cueBytes) throw new StudioError('limit_exceeded');
    return { plain, spans: this.spans };
  }
}

export function safeModelPlain(text: string): boolean {
  // The shared translation protocol reserves angle brackets for its protected marks.
  return !/[<>]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text);
}

export function bindPreservedBodies(doc: TextSubtitleDocument, structure: PreservedStructure): Map<string, PreservedBody> {
  if (structure.nodes.length !== doc.preservation.nodes.length) throw new StudioError('invalid_input');
  const pairedTargets = new Set(doc.cues.flatMap(cue => cue.importedPair ? [cue.importedPair.target.nodeId] : []));
  const bodies = new Map<string, PreservedBody>();
  structure.nodes.forEach((parsed, index) => {
    const node = doc.preservation.nodes[index];
    if (parsed.start !== node.start || parsed.end !== node.end || node.cueIds.length > 1) throw new StudioError('invalid_input');
    if (node.cueIds.length && !parsed.body) throw new StudioError('invalid_input');
    if (parsed.body && !node.cueIds.length && !pairedTargets.has(node.id)) throw new StudioError('invalid_input');
    if (parsed.body) bodies.set(node.id, parsed.body);
  });
  return bodies;
}
