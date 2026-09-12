import { StudioError, type SubtitleText } from '../domain';
import { BodyBuilder, rawLines, safeModelPlain, type PreservedStructure, type FormatNode } from './preserved';

export function assTime(raw: string): number {
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/.exec(raw.trim());
  if (!match) throw new StudioError('invalid_input');
  const value = Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]) * 10;
  if (!Number.isSafeInteger(value)) throw new StudioError('invalid_input');
  return value;
}

type Marks = ('b' | 'i' | 'u')[];
function topLevelTags(block: string): string[] {
  const tags: string[] = []; let start = -1; let depth = 0;
  for (let at = 0; at <= block.length; at++) {
    if (block[at] === '(') depth++;
    else if (block[at] === ')') depth = Math.max(0, depth - 1);
    if (at === block.length || (block[at] === '\\' && depth === 0)) {
      if (start >= 0) tags.push(block.slice(start, at));
      start = at + 1;
    }
  }
  return tags;
}

function assPayload(raw: string, start: number, end: number, wrapStyle: number, baseMarks: Marks, styles: Map<string, Marks>) {
  const builder = new BodyBuilder();
  let active = new Set(baseMarks); let initialMarks = [...active];
  let safe = true; let drawing = false; let sawDrawing = false; let karaoke = false;
  let styled = false; let positioning = false; let effects = false; let bodyStart = start; let leading = true;
  let wrap = wrapStyle;
  for (let at = start; at < end;) {
    if (raw[at] === '{') {
      const close = raw.indexOf('}', at + 1);
      if (close < 0 || close >= end) { safe = false; at++; continue; }
      const block = raw.slice(at + 1, close);
      styled = true;
      if (/\\(?:k[fo]?|K|kt)(?=[-+\d\\}]|$)/.test(block)) { karaoke = true; safe = false; effects = true; }
      if (/\\(?:pos|move|an|a|org|clip|iclip)(?=[(\d])/.test(block)) positioning = true;
      if (/\\(?:t|fad|fade)(?=\()/.test(block)) effects = true;
      const simple = /^(?:\\[biu](?:0|1|-1))*$/.test(block);
      // Interior arbitrary controls have offsets in the original wording. Keep them as
      // evidence, but never guess new offsets after translation.
      if (!leading && !simple) safe = false;
      for (const token of topLevelTags(block)) {
        const tag = /^(b|i|u)(-?\d+)$|^p(\d+)$|^q([0-3])$|^r(.*)$/.exec(token);
        if (!tag) continue;
        if (tag[1]) { if (Number(tag[2])) active.add(tag[1] as 'b' | 'i' | 'u'); else active.delete(tag[1] as 'b' | 'i' | 'u'); }
        if (tag[3]) { drawing = Number(tag[3]) > 0; if (drawing) { sawDrawing = true; effects = true; } }
        if (tag[4]) wrap = Number(tag[4]);
        if (tag[5] !== undefined) active = new Set(tag[5] ? styles.get(tag[5]) ?? baseMarks : baseMarks);
      }
      at = close + 1;
      if (leading) { bodyStart = at; initialMarks = [...active]; }
      continue;
    }
    leading = false;
    if (drawing) { at++; continue; }
    const escaped = raw[at] === '\\' ? raw[at + 1] : '';
    if (escaped === 'N' || escaped === 'n' || escaped === 'h') {
      builder.add(escaped === 'h' ? '\u00a0' : escaped === 'N' || wrap === 2 ? '\n' : ' ', at, at + 2, [...active]);
      at += 2; continue;
    }
    if (raw[at] === '}' || raw[at] === '\r' || raw[at] === '\n') safe = false;
    builder.add(raw[at], at, at + 1, [...active]); at++;
  }
  const text = builder.text();
  if (sawDrawing && text.plain.trim()) safe = false;
  safe &&= safeModelPlain(text.plain);
  return { bodyStart, bodyEnd: end, starts: builder.starts, ends: builder.ends, plain: text.plain, text, safe,
    prefix: raw.slice(start, bodyStart), suffix: '', styled, positioning, effects, sawDrawing, karaoke, initialMarks };
}

export function parseAssStructure(raw: string): PreservedStructure {
  const lines = rawLines(raw);
  // Styles are a separate section and may follow Events. Resolve the inherited basic
  // marks before projecting body spans, so translation cannot turn inherited italics off.
  const styles = new Map<string, Marks>();
  let styleSection = false; let styleFields: string[] | undefined;
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line.text);
    if (heading) { styleSection = heading[1].toLowerCase() === 'v4+ styles'; styleFields = undefined; continue; }
    if (!styleSection) continue;
    const declaration = /^\s*Format\s*:\s*(.*)$/i.exec(line.text);
    if (declaration) { styleFields = declaration[1].split(',').map(field => field.trim().toLowerCase()); continue; }
    const style = /^\s*Style\s*:\s*(.*)$/i.exec(line.text);
    if (!style || !styleFields) continue;
    const fields = style[1].split(',').map(field => field.trim());
    const name = fields[styleFields.indexOf('name')];
    if (!name) continue;
    const marks: Marks = [];
    for (const [field, mark] of [['bold', 'b'], ['italic', 'i'], ['underline', 'u']] as const) if (Number(fields[styleFields.indexOf(field)])) marks.push(mark);
    styles.set(name, marks);
  }
  const nodes: FormatNode[] = [];
  let section = ''; let sawScriptType = false; let sawEvents = false; let format: string[] | undefined; let wrapStyle = 0;
  for (const line of lines) {
    const node: FormatNode = { start: line.start, end: line.end, diagnostics: [] };
    nodes.push(node);
    const trimmed = line.text.trim();
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading) { section = heading[1].toLowerCase(); format = undefined; if (section === 'events') sawEvents = true; node.opaque = true; continue; }
    if (!trimmed || trimmed.startsWith(';')) { if (trimmed) node.opaque = true; continue; }
    if (section === 'script info') {
      if (/^ScriptType\s*:/i.test(trimmed)) { if (!/^ScriptType\s*:\s*v4\.00\+\s*$/i.test(trimmed)) throw new StudioError('unsupported_feature'); sawScriptType = true; }
      const wrap = /^WrapStyle\s*:\s*([0-3])\s*$/i.exec(trimmed); if (wrap) wrapStyle = Number(wrap[1]);
      node.opaque = true; continue;
    }
    if (section !== 'events') { node.opaque = true; continue; }
    const declaration = /^Format\s*:\s*(.*)$/i.exec(trimmed);
    if (declaration) {
      format = declaration[1].split(',').map(field => field.trim().toLowerCase());
      if (format.length > 32 || new Set(format).size !== format.length || format.at(-1) !== 'text' || !['start', 'end', 'style'].every(field => format!.includes(field))) throw new StudioError('unsupported_feature');
      node.opaque = true; continue;
    }
    const event = /^\s*(Dialogue|Comment)\s*:[ \t]*/i.exec(line.text);
    if (!event) { node.opaque = true; continue; }
    if (event[1].toLowerCase() === 'comment') { node.opaque = true; continue; }
    if (!format) throw new StudioError('invalid_input');
    const fields: string[] = [];
    let at = event[0].length;
    for (let index = 0; index < format.length - 1; index++) {
      const comma = line.text.indexOf(',', at);
      if (comma < 0) throw new StudioError('invalid_input');
      fields.push(line.text.slice(at, comma)); at = comma + 1;
    }
    const startMs = assTime(fields[format.indexOf('start')]); const endMs = assTime(fields[format.indexOf('end')]);
    if (endMs < startMs) throw new StudioError('invalid_input');
    const styleName = fields[format.indexOf('style')];
    const body = assPayload(raw, line.start + at, line.contentEnd, wrapStyle, styles.get(styleName) ?? [], styles);
    if (body.sawDrawing) node.diagnostics.push('ass_drawing');
    if (body.karaoke) node.diagnostics.push('ass_karaoke');
    if (!body.safe && !body.karaoke && !body.sawDrawing) node.diagnostics.push('unsupported_markup');
    if (body.sawDrawing && !body.text.plain.trim()) { node.opaque = true; continue; }
    node.body = { ...body, startMs, endMs,
      label: fields[format.indexOf('style')],
      positioning: body.positioning || ['marginl', 'marginr', 'marginv'].some(field => format!.includes(field) && Number(fields[format!.indexOf(field)]) !== 0),
      effects: body.effects || (format.includes('effect') && !!fields[format.indexOf('effect')].trim()),
    };
  }
  if (!sawScriptType || !sawEvents) throw new StudioError('invalid_input');
  return { nodes };
}

export function serializeAssText(text: SubtitleText, initialMarks: readonly ('b' | 'i' | 'u')[] = []): string {
  let active = new Set(initialMarks); let result = ''; let previousCR = false;
  for (const span of text.spans) {
    const normalized = (previousCR && span.text.startsWith('\n') ? span.text.slice(1) : span.text).replace(/\r\n|\r/g, '\n');
    previousCR = span.text.endsWith('\r');
    if (!normalized) continue;
    const next = new Set(span.marks);
    const controls = (['b', 'i', 'u'] as const).filter(mark => active.has(mark) !== next.has(mark)).map(mark => `\\${mark}${next.has(mark) ? 1 : 0}`).join('');
    if (controls) result += `{${controls}}`;
    result += normalized.replace(/\n/g, '\\N').replace(/\u00a0/g, '\\h');
    active = next;
  }
  if (active.size) result += `{${[...active].map(mark => `\\${mark}0`).join('')}}`;
  return result;
}

export const ASS_HEADER = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
