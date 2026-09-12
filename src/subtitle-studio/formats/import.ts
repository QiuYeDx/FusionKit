import { LIMITS, StudioError, validateDocument, type TextSubtitleDocument, type SubtitleText } from '../domain';

function parseText(raw: string): { text: SubtitleText; supported: boolean } {
  const spans: SubtitleText['spans'] = [];
  const stack: ('b' | 'i' | 'u')[] = [];
  let supported = !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw);
  for (const token of raw.split(/(<[^>]*>)/g)) {
    const tag = /^<(\/?)(b|i|u)>$/.exec(token);
    if (tag) {
      const mark = tag[2] as 'b' | 'i' | 'u';
      if (tag[1]) { if (stack.pop() !== mark) supported = false; }
      else { stack.push(mark); if (stack.length > 32) supported = false; }
    } else if (token) {
      if (/[<>]|\{\\/.test(token)) supported = false;
      spans.push({ text: token, marks: stack.slice(0, 32) });
    }
  }
  if (stack.length) supported = false;
  return supported ? { text: { plain: spans.map(span => span.text).join(''), spans }, supported } : { text: { plain: raw, spans: [{ text: raw, marks: [] }] }, supported };
}

function srtTime(raw: string): number {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(raw);
  if (!match) throw new StudioError('invalid_input');
  const ms = Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(ms)) throw new StudioError('invalid_input');
  return ms;
}

export function importSubtitleText(rawText: string, origin: TextSubtitleDocument['origin'], newId: () => string, bom = false): TextSubtitleDocument {
  if (new TextEncoder().encode(rawText).length > LIMITS.inputBytes) throw new StudioError('limit_exceeded');
  const doc: TextSubtitleDocument = {
    schemaVersion: 1, id: newId(), revision: 1, origin, cues: [], translationTracks: [], capabilities: { translate: true, preserveSource: true }, diagnostics: [],
    preservation: { schemaVersion: 1, rawText, bom, newline: rawText.includes('\r\n') ? /(^|[^\r])\n/.test(rawText) ? 'mixed' : 'crlf' : 'lf', offsetMs: 0, nodes: [] },
  };
  const add = (node: TextSubtitleDocument['preservation']['nodes'][number], text: string, startMs: number, endMs: number | null, sourceLabel?: string) => {
    if (doc.cues.length >= LIMITS.cues || new TextEncoder().encode(text).length > LIMITS.cueBytes) throw new StudioError('limit_exceeded');
    if (!Number.isSafeInteger(startMs) || (endMs !== null && (!Number.isSafeInteger(endMs) || endMs < startMs))) throw new StudioError('invalid_input');
    const parsed = parseText(text);
    if (!parsed.supported && !doc.diagnostics.some(d => d.nodeId === node.id && d.code === 'unsupported_markup')) {
      doc.diagnostics.push({ code: 'unsupported_markup', nodeId: node.id }); doc.capabilities.translate = false;
    }
    if (startMs < 0) doc.diagnostics.push({ code: 'negative_time', nodeId: node.id });
    if (endMs === startMs) doc.diagnostics.push({ code: 'zero_duration', nodeId: node.id });
    const id = newId(); node.cueIds.push(id);
    doc.cues.push({ id, sourceRevision: 1, timingRevision: 1, timing: { startMs, endMs, provenance: origin.format === 'srt' ? 'srt' : 'lrc_offset' }, source: parsed.text, nodeId: node.id, ...(sourceLabel === undefined ? {} : { sourceLabel }) });
  };
  if (origin.format === 'srt') {
    // Ranges cover every original character, including separators and line endings.
    const blocks = /[\s\S]*?(?:(?:\r?\n)[ \t]*(?:\r?\n)+|$)/g;
    for (const match of rawText.matchAll(blocks)) {
      if (!match[0]) continue;
      if (doc.preservation.nodes.length >= LIMITS.nodes) throw new StudioError('limit_exceeded');
      const node = { id: newId(), start: match.index!, end: match.index! + match[0].length, cueIds: [] as string[] };
      doc.preservation.nodes.push(node);
      const body = match[0].replace(/(?:\r?\n[ \t]*)+$/, '');
      if (!body.trim()) continue;
      const lines = body.split(/\r?\n/);
      if (!/^\d{1,100}$/.test(lines[0]) || lines.length < 2) throw new StudioError('invalid_input');
      const timing = /^(\d{2,}:[0-5]\d:[0-5]\d,\d{3})[ \t]+-->[ \t]+(\d{2,}:[0-5]\d:[0-5]\d,\d{3})[ \t]*$/.exec(lines[1]);
      if (!timing) throw new StudioError('invalid_input');
      add(node, lines.slice(2).join('\n'), srtTime(timing[1]), srtTime(timing[2]), lines[0]);
    }
  } else {
    const offsets = [...rawText.matchAll(/^\[offset:([+-]?\d+)\][ \t]*\r?$/gm)];
    if (offsets.length > 1) throw new StudioError('invalid_input');
    doc.preservation.offsetMs = offsets.length ? Number(offsets[0][1]) : 0;
    if (!Number.isSafeInteger(doc.preservation.offsetMs)) throw new StudioError('invalid_input');
    for (const match of rawText.matchAll(/[^\n]*(?:\n|$)/g)) {
      if (!match[0]) continue;
      if (doc.preservation.nodes.length >= LIMITS.nodes) throw new StudioError('limit_exceeded');
      const node = { id: newId(), start: match.index!, end: match.index! + match[0].length, cueIds: [] as string[] };
      doc.preservation.nodes.push(node);
      const line = match[0].replace(/\r?\n$/, '');
      if (/^\[offset:/i.test(line) && !/^\[offset:[+-]?\d+\][ \t]*$/.test(line)) throw new StudioError('invalid_input');
      if (!line.trim() || /^\[[a-zA-Z][\w-]*:[^\]]*\][ \t]*$/.test(line)) continue;
      let consumed = 0;
      const times: number[] = [];
      for (const tag of line.matchAll(/\[(\d+):([0-5]\d)(?:\.(\d{1,3}))?\]/g)) {
        if (tag.index !== consumed) break;
        if (times.length + doc.cues.length >= LIMITS.cues) throw new StudioError('limit_exceeded');
        times.push(Number(tag[1]) * 60000 + Number(tag[2]) * 1000 + Number((tag[3] ?? '').padEnd(3, '0')) + doc.preservation.offsetMs);
        consumed += tag[0].length;
      }
      if (!times.length) {
        if (/^\[\d|^\[offset:/.test(line)) throw new StudioError('invalid_input');
        doc.diagnostics.push({ code: 'untimed_text', nodeId: node.id }); doc.capabilities.translate = false;
        continue;
      }
      const text = line.slice(consumed);
      if (/<\d+:\d{2}(?:\.\d+)?>/.test(text)) {
        doc.diagnostics.push({ code: 'enhanced_lrc', nodeId: node.id }); doc.capabilities.translate = false;
      }
      for (const time of times) add(node, text, time, null);
    }
  }
  if (!doc.cues.length) { doc.diagnostics.push({ code: 'empty_document' }); doc.capabilities.translate = false; }
  return validateDocument(doc) as TextSubtitleDocument;
}
