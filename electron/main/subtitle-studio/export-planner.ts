import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import { LIMITS, StudioError, validateDocument, type SubtitleCue, type SubtitleDocument, type SubtitleText } from '../../../src/subtitle-studio/domain';
import { exportOptionsSchema, type ExportIssue, type ExportIssueCode, type ExportOptions, type ExportPlanSummary } from '../../../src/subtitle-studio/export-contract';

export type SubtitleExportPlan = Omit<ExportPlanSummary, 'planId'> & { bytes: Buffer | null };
const sourceHash = (cue: SubtitleCue) => createHash('sha256').update(JSON.stringify(cue.source)).digest('hex');
const pad = (number: number, width = 2) => String(number).padStart(width, '0');
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const srtTime = (value: number) => `${pad(Math.floor(value / 3600000))}:${pad(Math.floor(value / 60000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${pad(value % 1000, 3)}`;
const lrcTime = (value: number) => `[${pad(Math.floor(value / 60000))}:${pad(Math.floor(value / 1000) % 60)}.${pad(value % 1000, 3)}]`;

class BoundedText {
  private parts: string[] = [];
  private size = 0;
  add(text: string) {
    this.size += Buffer.byteLength(text);
    if (this.size > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
    this.parts.push(text);
  }
  text() { return this.parts.join(''); }
}

function unsupportedText(text: string, format: ExportOptions['format']): boolean {
  if (/[<>]|\{\\|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return true;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  if (format === 'lrc') return /\[\d+:[0-5]\d(?:\.\d{1,3})?\]/.test(text);
  // Blank body lines are SRT block delimiters, including leading/trailing blank lines.
  return text.trim().length > 0 && text.split(/\r\n|\r|\n/).some(line => !line.trim());
}

function srtText(text: SubtitleText): string {
  const output = new BoundedText();
  let open: SubtitleText['spans'][number]['marks'] = [];
  let previousEndedInCR = false;
  for (const span of text.spans) {
    if (!span.text) continue;
    // A CRLF pair can cross a style boundary and must remain one visual newline.
    const normalized = (previousEndedInCR && span.text.startsWith('\n') ? span.text.slice(1) : span.text).replace(/\r\n|\r/g, '\n');
    previousEndedInCR = span.text.endsWith('\r');
    if (!normalized) continue;
    let common = 0;
    while (common < open.length && common < span.marks.length && open[common] === span.marks[common]) common++;
    output.add(open.slice(common).reverse().map(mark => `</${mark}>`).join(''));
    output.add(span.marks.slice(common).map(mark => `<${mark}>`).join(''));
    output.add(normalized);
    open = span.marks;
  }
  output.add([...open].reverse().map(mark => `</${mark}>`).join(''));
  return output.text();
}

function outputName(doc: SubtitleDocument, options: ExportOptions, partial: boolean): string {
  const base = doc.origin.displayName.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || 'subtitle';
  return `${base}.${options.mode}${partial ? '.partial' : ''}.${options.format}`;
}

/** Freeze a local projection of one document revision; planning never performs I/O or inference. */
export function planSubtitleExport(value: SubtitleDocument, input: ExportOptions): SubtitleExportPlan {
  const parsed = exportOptionsSchema.safeParse(input);
  if (!parsed.success || (parsed.data.bom && !['utf-8', 'utf-16le'].includes(parsed.data.encoding))) throw new StudioError('invalid_input');
  const options = parsed.data;
  const doc = validateDocument(value);
  const issues = new Map<ExportIssueCode, ExportIssue>();
  const issue = (code: ExportIssueCode, count = 1, blocking = false, confirmation = false) => {
    if (!count) return;
    const previous = issues.get(code);
    issues.set(code, { code, count: (previous?.count ?? 0) + count, blocking: blocking || !!previous?.blocking, confirmation: confirmation || !!previous?.confirmation });
  };
  const track = options.mode === 'source' ? undefined : doc.translationTracks.find(item => item.id === options.trackId);
  if (options.mode !== 'source' && !track) issue('track_missing', 1, true);
  // Targets preserved only as original evidence after bilingual separation are not metadata.
  const pairedTargets = new Set(doc.cues.flatMap(cue => cue.importedPair ? [cue.importedPair.target.nodeId] : []));
  if (doc.schemaVersion === 2) issue('transcription_evidence_omitted', 1, false, true);
  else {
    const omitted = doc.preservation.nodes.filter(node => !node.cueIds.length && !pairedTargets.has(node.id) && doc.preservation.rawText.slice(node.start, node.end).trim()).length;
    issue('metadata_omitted', omitted, false, true);
  }
  const starts = [...new Set(doc.cues.map(cue => cue.timing.startMs))].sort((a, b) => a - b);
  const nextStarts = new Map(starts.map((start, index) => [start, starts[index + 1]]));
  const output = new BoundedText();
  let cueCount = 0; let missingCount = 0; let staleCount = 0;
  for (const cue of doc.cues) {
    let texts = [cue.source];
    if (options.mode !== 'source') {
      if (!track) continue;
      const entry = track.entries[cue.id];
      // Empty source events are omitted from model requests and need no invented translation.
      const missing = !!cue.source.plain.trim() && (!entry || !entry.text.plain.trim());
      const stale = !!entry && !missing && (entry.sourceRevision !== cue.sourceRevision || entry.sourceHash !== sourceHash(cue));
      if (missing || stale) {
        if (missing) { missingCount++; issue('translation_missing', 1, options.incomplete === 'block'); }
        else { staleCount++; issue('translation_stale', 1, options.incomplete === 'block'); }
        if (options.incomplete === 'block') continue;
        if (options.incomplete === 'skip') { issue('skipped_cues'); continue; }
        issue('source_fallback');
      } else if (entry) {
        texts = options.mode === 'target' ? [entry.text] : options.order === 'source-first' ? [cue.source, entry.text] : [entry.text, cue.source];
      }
    }
    let end = cue.timing.endMs;
    if (options.format === 'srt' && end === null) {
      if (options.missingEnd.mode === 'block') { issue('missing_end', 1, true); continue; }
      end = nextStarts.get(cue.timing.startMs) ?? cue.timing.startMs + options.missingEnd.finalDurationMs;
      issue('estimated_end');
    }
    if (!validTime(cue.timing.startMs) || (options.format === 'srt' && (end === null || !validTime(end) || end < cue.timing.startMs))) { issue('invalid_time', 1, true); continue; }
    if (texts.some(text => unsupportedText(text.plain, options.format))) { issue('unsupported_text', 1, true); continue; }
    if (options.format === 'lrc') {
      if (end !== null) issue('end_times_omitted', 1, false, true);
      if (texts.some(text => text.spans.some(span => span.text && span.marks.length))) issue('styles_removed', 1, false, true);
      if (texts.some(text => /[\r\n]/.test(text.plain))) issue('line_breaks_flattened', 1, false, true);
      for (const text of texts) output.add(`${lrcTime(cue.timing.startMs)}${text.plain.replace(/(?:\r\n|\r|\n)+/g, ' ')}\n`);
    } else {
      output.add(`${cueCount + 1}\n${srtTime(cue.timing.startMs)} --> ${srtTime(end!)}\n`);
      output.add(texts.filter(text => text.plain.trim().length).map(srtText).join('\n'));
      output.add('\n\n');
    }
    cueCount++;
  }
  if (!cueCount) issue('empty_output', 1, true);
  const text = output.text().replace(/\n/g, options.newline === 'crlf' ? '\r\n' : '\n');
  if (Buffer.byteLength(text) > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
  const encoded = iconv.encode(text, options.encoding);
  if (encoded.length > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
  if (iconv.decode(encoded, options.encoding, { stripBOM: false }) !== text) issue('encoding_unrepresentable', 1, true);
  const bom = options.bom ? options.encoding === 'utf-8' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.from([0xff, 0xfe]) : Buffer.alloc(0);
  const bytes = [...issues.values()].some(item => item.blocking) ? null : Buffer.concat([bom, encoded]);
  if (bytes && bytes.length > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
  const partial = missingCount + staleCount > 0 && options.incomplete !== 'block';
  return { documentId: doc.id, revision: doc.revision, options, cueCount, sourceCueCount: doc.cues.length, missingCount, staleCount,
    byteLength: bytes?.length ?? 0, fileName: outputName(doc, options, partial), issues: [...issues.values()], preview: text.slice(0, 2000), partial, bytes };
}
