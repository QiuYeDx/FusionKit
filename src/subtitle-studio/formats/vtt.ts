import { StudioError, type SubtitleText } from '../domain';
import { BodyBuilder, rawLines, safeModelPlain, type PreservedBody, type PreservedStructure, type FormatNode } from './preserved';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
export function vttTime(raw: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(raw);
  if (!match) throw new StudioError('invalid_input');
  const value = Number(match[1] ?? 0) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(value)) throw new StudioError('invalid_input');
  return value;
}

function payload(raw: string, start: number, end: number): Omit<PreservedBody, 'startMs' | 'endMs' | 'label' | 'positioning'> {
  const builder = new BodyBuilder();
  const marks: ('b' | 'i' | 'u')[] = [];
  let safe = true; let styled = false; let effects = false;
  let bodyStart = start; let bodyEnd = end;
  // Whole-cue semantic wrappers have no translated offsets and can survive as an envelope.
  let prefix = ''; let suffix = '';
  for (let depth = 0; depth < 32; depth++) {
    const open = /^<(c(?:\.[\w-]+)*|v(?:\.[\w-]+)*[ \t]+[^<>\r\n]+|lang[ \t]+[^<>\r\n]+)>/.exec(raw.slice(bodyStart, bodyEnd));
    if (!open) break;
    const name = /^[a-z]+/.exec(open[1])![0];
    const close = `</${name}>`;
    const hasClose = raw.slice(bodyStart, bodyEnd).endsWith(close);
    if (!hasClose && name !== 'v') break;
    prefix += open[0]; bodyStart += open[0].length;
    if (hasClose) { bodyEnd -= close.length; suffix = close + suffix; }
    styled = true;
  }
  for (let at = bodyStart; at < bodyEnd;) {
    if (raw[at] === '<') {
      const tag = /^<(\/?)(b|i|u)>/.exec(raw.slice(at, bodyEnd));
      if (tag) {
        styled = true;
        const mark = tag[2] as 'b' | 'i' | 'u';
        if (tag[1]) { if (marks.pop() !== mark) safe = false; }
        else { if (marks.length < 32) marks.push(mark); else safe = false; }
        at += tag[0].length; continue;
      }
      const opaque = /^<[^>]*>/.exec(raw.slice(at, bodyEnd));
      if (opaque) { safe = false; effects = true; at += opaque[0].length; continue; }
      safe = false;
    }
    if (raw[at] === '&') {
      const entity = /^&(amp|lt|gt|nbsp|lrm|rlm);/.exec(raw.slice(at, bodyEnd));
      if (entity) { builder.add(ENTITIES[entity[1]], at, at + entity[0].length, marks); at += entity[0].length; continue; }
    }
    const length = raw[at] === '\r' && raw[at + 1] === '\n' ? 2 : 1;
    builder.add(raw[at] === '\r' ? '\n' : raw[at], at, at + length, marks); at += length;
  }
  if (marks.length) safe = false;
  const text = builder.text();
  safe &&= safeModelPlain(text.plain) && !text.plain.includes('-->');
  return { bodyStart, bodyEnd, starts: builder.starts, ends: builder.ends, plain: text.plain, text, safe, prefix, suffix, effects, styled };
}

export function parseVttStructure(raw: string): PreservedStructure {
  const lines = rawLines(raw);
  if (!lines.length || !/^WEBVTT(?:[ \t].*)?$/.test(lines[0].text) || lines[0].text.includes('-->')) throw new StudioError('invalid_input');
  const nodes: FormatNode[] = [];
  let cursor = 0; let previousStart = -1;
  while (cursor < lines.length) {
    const start = cursor;
    while (cursor < lines.length && lines[cursor].text.trim()) cursor++;
    const contentEnd = cursor;
    while (cursor < lines.length && !lines[cursor].text.trim()) cursor++;
    const node: FormatNode = { start: lines[start].start, end: lines[cursor - 1].end, diagnostics: [] };
    nodes.push(node);
    if (start === 0) {
      if (lines.slice(1, contentEnd).some(line => line.text.includes('-->'))) throw new StudioError('invalid_input');
      if (contentEnd > 1) node.opaque = true;
      continue;
    }
    if (contentEnd === start) continue;
    const first = lines[start].text;
    if (/^NOTE(?:[ \t]|$)/.test(first) || first === 'STYLE' || first === 'REGION') { node.opaque = true; continue; }
    if (!lines.slice(start, contentEnd).some(line => line.text.includes('-->'))) { node.opaque = true; continue; }
    const timeIndex = first.includes('-->') ? start : start + 1;
    if (timeIndex >= contentEnd) throw new StudioError('invalid_input');
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(lines[timeIndex].text);
    if (!match) throw new StudioError('invalid_input');
    const startMs = vttTime(match[1]); const endMs = vttTime(match[2]);
    if (endMs <= startMs || startMs < previousStart) throw new StudioError('invalid_input');
    previousStart = startMs;
    const bodyStart = lines[timeIndex].end;
    const bodyEnd = timeIndex + 1 < contentEnd ? lines[contentEnd - 1].contentEnd : bodyStart;
    const body = payload(raw, bodyStart, bodyEnd);
    node.body = { ...body, startMs, endMs, positioning: !!match[3]?.trim(), ...(timeIndex !== start ? { label: first } : {}) };
    if (!body.safe) node.diagnostics.push('vtt_payload_unsupported');
  }
  return { nodes };
}

export const escapeVttText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function serializeVttText(text: SubtitleText): string {
  let open: ('b' | 'i' | 'u')[] = [];
  let result = ''; let previousCR = false;
  for (const span of text.spans) {
    const normalized = (previousCR && span.text.startsWith('\n') ? span.text.slice(1) : span.text).replace(/\r\n|\r/g, '\n');
    previousCR = span.text.endsWith('\r');
    if (!normalized) continue;
    let common = 0;
    while (common < open.length && common < span.marks.length && open[common] === span.marks[common]) common++;
    result += open.slice(common).reverse().map(mark => `</${mark}>`).join('') + span.marks.slice(common).map(mark => `<${mark}>`).join('') + escapeVttText(normalized);
    open = [...span.marks];
  }
  return result + open.reverse().map(mark => `</${mark}>`).join('');
}
