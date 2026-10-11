import { randomUUID } from 'node:crypto';
import { StudioError, validateDocument, type SubtitleCue, type SubtitleText, type TranslationEntry } from '../../../src/subtitle-studio/domain';
import { CUE_EDIT_LIMIT, cueEditOperationSchema, storedTextProblem, type CueEditOperation, type RemovedCues, type SingleCueEditOperation } from '../../../src/subtitle-studio/cue-edit-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { shiftProblem, shiftStart } from '../../../src/subtitle-studio/cue-shift';
import { replaceText } from '../../../src/subtitle-studio/cue-find';
import type { DocumentRepository } from './document-repository';
import { sourceDigest } from './translation-planner';
import { retireResumableTasks } from './translation-service';

type Track = DocumentSnapshot['document']['translationTracks'][number];
export type AppliedCueEdit = { undo: CueEditOperation; changed: number; stoppedTasks: number };

function assertStoredText(text: SubtitleText) {
  if (storedTextProblem(text)) throw new StudioError('invalid_input');
}

/**
 * Applies one cue edit inside a document transaction. Edits never race a
 * running translation; paused tasks that the edit invalidates are stopped so
 * they cannot later fail to resume.
 */
export function applyCueEdit(snapshot: DocumentSnapshot, input: CueEditOperation): AppliedCueEdit {
  const parsed = cueEditOperationSchema.safeParse(input);
  if (!parsed.success) throw new StudioError('invalid_input');
  const doc = snapshot.document;
  if (snapshot.tasks.some(task => task.status === 'queued' || task.status === 'running')) throw new StudioError('resource_busy');
  const operations = parsed.data.kind === 'batch' ? parsed.data.operations : [parsed.data];
  // Positions are rebuilt after an operation adds or removes cues.
  let indices: Map<string, number> | null = null;
  const positions = () => indices ??= new Map(doc.cues.map((cue, index) => [cue.id, index]));
  const cueOf = (id: string) => {
    const index = positions().get(id);
    if (index === undefined) throw new StudioError('invalid_input');
    return doc.cues[index];
  };
  const trackOf = (id: string) => {
    const track = doc.translationTracks.find(item => item.id === id);
    if (!track) throw new StudioError('invalid_input');
    return track;
  };
  /** Replaces entries and returns the previous ones; entries are compared by value. */
  const writeEntries = (track: Track, entries: Record<string, TranslationEntry | null>) => {
    const previous: Record<string, TranslationEntry | null> = {};
    for (const [cueId, entry] of Object.entries(entries)) {
      cueOf(cueId);
      const before = track.entries[cueId] ?? null;
      if (JSON.stringify(before) === JSON.stringify(entry)) continue;
      if (entry) {
        assertStoredText(entry.text);
        track.entries[cueId] = structuredClone(entry);
      } else delete track.entries[cueId];
      previous[cueId] = before && structuredClone(before);
    }
    return previous;
  };
  const changedEntries = (track: Track, previous: Record<string, TranslationEntry | null>): AppliedCueEdit => {
    const changed = Object.keys(previous).length;
    const undo: CueEditOperation = { kind: 'entries', trackId: track.id, entries: previous };
    if (!changed) return { undo, changed, stoppedTasks: 0 };
    // Content changes move the track revision, which paused tasks on the track were checked against.
    track.revision++;
    return { undo, changed, stoppedTasks: retireResumableTasks(snapshot, track.id) };
  };

  const writeSource = (cue: SubtitleCue, text: SubtitleText) => {
    assertStoredText(text);
    // Transcripts carry plain text only.
    if (doc.schemaVersion === 2 && text.spans.some(span => span.marks.length)) throw new StudioError('invalid_input');
    cue.source = structuredClone(text);
    cue.sourceRevision++;
    // A translation made for exactly this text (for example before an undone edit) is current again.
    const digest = sourceDigest(cue);
    for (const track of doc.translationTracks) {
      const entry = track.entries[cue.id];
      if (entry && entry.sourceHash === digest) entry.sourceRevision = cue.sourceRevision;
    }
  };

  /** A cue's start may not move past a neighbour it was not already past. */
  const keepsOrder = (index: number, before: number, after: number) => {
    const previous = doc.cues[index - 1]?.timing.startMs, next = doc.cues[index + 1]?.timing.startMs;
    if (previous !== undefined && after < previous && before >= previous) return false;
    if (next !== undefined && after > next && before <= next) return false;
    return true;
  };
  const writeTiming = (cue: SubtitleCue, startMs: number, endMs: number | null) => {
    if (endMs !== null && endMs < startMs) throw new StudioError('invalid_input');
    // Transcripts always know when a line ends, and it ends within the media.
    if (doc.schemaVersion === 2 && (endMs === null || endMs <= 0 || endMs > doc.origin.durationMs)) throw new StudioError('invalid_input');
    if (cue.timing.startMs === startMs && cue.timing.endMs === endMs) return false;
    (cue.timing as { startMs: number; endMs: number | null }).startMs = startMs;
    (cue.timing as { startMs: number; endMs: number | null }).endMs = endMs;
    cue.timingRevision++;
    return true;
  };

  /**
   * Adds a cue at `index`, beside `anchor`: it shares the anchor's original-file node (its times
   * are retimed, so the file is written anew) or transcript segment, and counts as edited.
   */
  const addCue = (index: number, anchor: SubtitleCue, startMs: number, endMs: number | null, source: SubtitleText): SubtitleCue => {
    assertStoredText(source);
    if (doc.schemaVersion === 2 && source.spans.some(span => span.marks.length)) throw new StudioError('invalid_input');
    const id = randomUUID();
    const cue = ('segmentId' in anchor
      ? { id, sourceRevision: 2, timingRevision: 2, segmentId: anchor.segmentId, timing: { startMs, endMs, provenance: anchor.timing.provenance }, source: structuredClone(source) }
      : { id, sourceRevision: 2, timingRevision: 2, nodeId: anchor.nodeId, timing: { startMs, endMs, provenance: anchor.timing.provenance }, source: structuredClone(source) }) as SubtitleCue;
    (doc.cues as SubtitleCue[]).splice(index, 0, cue);
    indices = null;
    if (doc.schemaVersion === 1) {
      const node = doc.preservation.nodes.find(item => item.id === (anchor as { nodeId: string }).nodeId);
      if (!node) throw new StudioError('invalid_input');
      node.cueIds = [...node.cueIds, id].sort((a, b) => positions().get(a)! - positions().get(b)!);
    }
    return cue;
  };
  /** Writes human translations of `cues` on the track and returns the entries they replace. */
  const writeHumanTargets = (track: Track, targets: [SubtitleCue, SubtitleText][]) => {
    const previous: Record<string, TranslationEntry | null> = {};
    for (const [cue, text] of targets) {
      assertStoredText(text);
      previous[cue.id] = structuredClone(track.entries[cue.id] ?? null);
      track.entries[cue.id] = { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), text: structuredClone(text), origin: 'human', reviewStatus: 'reviewed' };
    }
    track.revision++;
    return previous;
  };

  const applyOne = (operation: SingleCueEditOperation): AppliedCueEdit => { let applied: AppliedCueEdit;
  switch (operation.kind) {
    case 'source': {
      const cue = cueOf(operation.cueId);
      const undo: CueEditOperation = { kind: 'source', cueId: cue.id, text: structuredClone(cue.source) };
      writeSource(cue, operation.text);
      applied = { undo, changed: 1, stoppedTasks: retireResumableTasks(snapshot) };
      break;
    }
    case 'revise': {
      const track = operation.trackId ? trackOf(operation.trackId) : undefined;
      if ((operation.targets || operation.entries) && !track) throw new StudioError('invalid_input');
      const touched = [...new Set([...Object.keys(operation.sources), ...Object.keys(operation.targets ?? {}), ...Object.keys(operation.entries ?? {})])];
      touched.forEach(cueOf);
      const before = track ? Object.fromEntries(touched.map(id => [id, structuredClone(track.entries[id] ?? null)])) : {};
      const sources: Record<string, SubtitleText> = {};
      for (const [cueId, text] of Object.entries(operation.sources)) {
        const cue = cueOf(cueId);
        if (JSON.stringify(cue.source) === JSON.stringify(text)) continue;
        sources[cueId] = structuredClone(cue.source);
        writeSource(cue, text);
      }
      if (track) {
        for (const [cueId, text] of Object.entries(operation.targets ?? {})) {
          const cue = cueOf(cueId);
          assertStoredText(text);
          const entry = track.entries[cueId];
          const current = { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue) };
          // An unchanged translation was confirmed for the new source and keeps its origin and review mark.
          if (entry && JSON.stringify(entry.text) === JSON.stringify(text)) Object.assign(entry, current);
          else track.entries[cueId] = { ...current, text: structuredClone(text), origin: 'ai', reviewStatus: 'reviewed' };
        }
        for (const [cueId, value] of Object.entries(operation.entries ?? {})) {
          const cue = cueOf(cueId);
          if (!value) { delete track.entries[cueId]; continue; }
          assertStoredText(value.text);
          const entry = structuredClone(value);
          // Undo restores the old source first, which moved its revision on: a translation of exactly that text is current.
          if (entry.sourceHash === sourceDigest(cue)) entry.sourceRevision = cue.sourceRevision;
          track.entries[cueId] = entry;
        }
      }
      const entries: Record<string, TranslationEntry | null> = {};
      if (track) for (const id of touched) if (JSON.stringify(before[id]) !== JSON.stringify(track.entries[id] ?? null)) entries[id] = before[id];
      const changed = new Set([...Object.keys(sources), ...Object.keys(entries)]).size;
      // Translation content changes move the track revision, which paused tasks on the track were checked against.
      if (track && Object.keys(entries).length) track.revision++;
      const undo: CueEditOperation = { kind: 'revise', sources, ...(track ? { trackId: track.id, entries } : {}) };
      const stoppedTasks = Object.keys(sources).length ? retireResumableTasks(snapshot) : Object.keys(entries).length ? retireResumableTasks(snapshot, track!.id) : 0;
      applied = { undo, changed, stoppedTasks };
      break;
    }
    case 'target': {
      const track = trackOf(operation.trackId);
      const cue = cueOf(operation.cueId);
      const entry: TranslationEntry | null = operation.text && { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), text: operation.text, origin: 'human', reviewStatus: 'reviewed' };
      applied = changedEntries(track, writeEntries(track, { [cue.id]: entry }));
      break;
    }
    case 'clear': {
      const track = trackOf(operation.trackId);
      applied = changedEntries(track, writeEntries(track, Object.fromEntries(operation.cueIds.map(id => [id, null]))));
      break;
    }
    case 'entries': {
      const track = trackOf(operation.trackId);
      applied = changedEntries(track, writeEntries(track, operation.entries));
      break;
    }
    case 'review': {
      const track = trackOf(operation.trackId);
      const status = operation.reviewed ? 'reviewed' : 'unreviewed';
      const previous: Record<string, TranslationEntry> = {};
      for (const id of operation.cueIds) {
        cueOf(id);
        const entry = track.entries[id];
        if (!entry || entry.reviewStatus === status) continue;
        previous[id] = structuredClone(entry);
        entry.reviewStatus = status;
      }
      // Review marks are not translation content: paused tasks stay resumable.
      applied = { undo: { kind: 'entries', trackId: track.id, entries: previous }, changed: Object.keys(previous).length, stoppedTasks: 0 };
      break;
    }
    case 'delete':
      applied = deleteCues(snapshot, operation.cueIds, cueOf);
      indices = null;
      break;
    case 'restore':
      applied = restoreCues(snapshot, operation.removed);
      indices = null;
      break;
    case 'timing': {
      const previous: Record<string, { startMs: number; endMs: number | null }> = {};
      const changes = Object.entries(operation.changes).map(([cueId, timing]) => {
        const cue = cueOf(cueId);
        return { cue, timing, before: { startMs: cue.timing.startMs, endMs: cue.timing.endMs } };
      });
      for (const { cue, timing, before } of changes) if (writeTiming(cue, timing.startMs, timing.endMs)) previous[cue.id] = before;
      // Checked once every change is in, so a group may move together past where one of them was.
      for (const { cue, before } of changes) if (!keepsOrder(positions().get(cue.id)!, before.startMs, cue.timing.startMs)) throw new StudioError('invalid_input');
      // Nothing moved: the undo is the same no-op.
      applied = { undo: { kind: 'timing', changes: Object.keys(previous).length ? previous : Object.fromEntries(changes.map(({ cue, before }) => [cue.id, before])) },
        changed: Object.keys(previous).length, stoppedTasks: 0 };
      break;
    }
    case 'shift': {
      const from = shiftStart(doc.cues, operation.fromCueId);
      if (shiftProblem(doc.cues, from, operation.deltaMs, doc.schemaVersion === 2 ? doc.origin.durationMs : undefined)) throw new StudioError('invalid_input');
      // Every cue moves by the same amount, so lengths and order within the range stay as they were.
      for (const cue of doc.cues.slice(from) as SubtitleCue[]) {
        const timing = cue.timing as { startMs: number; endMs: number | null };
        timing.startMs += operation.deltaMs;
        if (timing.endMs !== null) timing.endMs += operation.deltaMs;
        cue.timingRevision++;
      }
      applied = { undo: { kind: 'shift', deltaMs: -operation.deltaMs, ...(operation.fromCueId ? { fromCueId: operation.fromCueId } : {}) }, changed: doc.cues.length - from, stoppedTasks: 0 };
      break;
    }
    case 'split': {
      const cue = cueOf(operation.cueId);
      const index = positions().get(cue.id)!;
      const { startMs, endMs } = cue.timing;
      if (operation.splitMs <= startMs || (endMs !== null && operation.splitMs >= endMs)) throw new StudioError('invalid_input');
      const track = operation.trackId ? trackOf(operation.trackId) : undefined;
      const undo: SingleCueEditOperation[] = [];
      const oldSource = structuredClone(cue.source);
      const oldEntries = Object.fromEntries(doc.translationTracks.map(item => [item.id, structuredClone(item.entries[cue.id] ?? null)]));
      writeSource(cue, operation.sources[0]);
      writeTiming(cue, startMs, operation.splitMs);
      undo.push({ kind: 'timing', changes: { [cue.id]: { startMs, endMs } } });
      const added = addCue(index + 1, cue, operation.splitMs, endMs, operation.sources[1]);
      if (track && operation.targets) writeHumanTargets(track, [[cue, operation.targets[0]], [added, operation.targets[1]]]);
      // Undo puts back the text and every translation the cue had before.
      undo.push({ kind: 'revise', sources: { [cue.id]: oldSource } });
      for (const [trackId, entry] of Object.entries(oldEntries)) if (JSON.stringify(entry) !== JSON.stringify(trackOf(trackId).entries[cue.id] ?? null)) undo.push({ kind: 'entries', trackId, entries: { [cue.id]: entry } });
      undo.push({ kind: 'delete', cueIds: [added.id] });
      applied = { undo: { kind: 'batch', operations: undo.reverse() }, changed: 2, stoppedTasks: retireResumableTasks(snapshot) };
      break;
    }
    case 'insert': {
      const anchor = cueOf(operation.cueId);
      const index = positions().get(anchor.id)! + (operation.position === 'after' ? 1 : 0);
      const { startMs, endMs } = operation.timing;
      const previous = doc.cues[index - 1]?.timing.startMs, next = doc.cues[index]?.timing.startMs;
      // The same order rule as retiming: no start before the cue ahead or after the cue behind.
      if ((previous !== undefined && startMs < previous) || (next !== undefined && startMs > next)) throw new StudioError('invalid_input');
      if (endMs !== null && endMs < startMs) throw new StudioError('invalid_input');
      if (doc.schemaVersion === 2 && (endMs === null || endMs <= 0 || endMs > doc.origin.durationMs)) throw new StudioError('invalid_input');
      // An unknown end only where the format has one (LRC) or the neighbour has none, as when retiming.
      if (doc.schemaVersion === 1 && endMs === null && doc.origin.format !== 'lrc' && anchor.timing.endMs !== null) throw new StudioError('invalid_input');
      const track = operation.trackId ? trackOf(operation.trackId) : undefined;
      const added = addCue(index, anchor, startMs, endMs, operation.source);
      if (track && operation.target) writeHumanTargets(track, [[added, operation.target]]);
      applied = { undo: { kind: 'delete', cueIds: [added.id] }, changed: 1, stoppedTasks: retireResumableTasks(snapshot) };
      break;
    }
    case 'replace': {
      const track = operation.trackId ? trackOf(operation.trackId) : undefined;
      if (operation.field !== 'source' && !track) throw new StudioError('invalid_input');
      // The replacement is typed text: no markup brackets, as in an inline edit.
      if (/[<>]/.test(operation.replacement)) throw new StudioError('invalid_input');
      const cues = operation.cueIds ? operation.cueIds.map(cueOf) : doc.cues as SubtitleCue[];
      const oldSources: Record<string, SubtitleText> = {};
      const targets: Record<string, TranslationEntry> = {};
      const touched = new Set<string>();
      for (const cue of cues) {
        if (operation.field !== 'target') {
          const next = replaceText(cue.source, operation.query, operation.replacement, operation.matchCase);
          if (next) { oldSources[cue.id] = structuredClone(cue.source); writeSource(cue, next); touched.add(cue.id); }
        }
        const entry = track && operation.field !== 'source' ? track.entries[cue.id] : undefined;
        const text = entry && replaceText(entry.text, operation.query, operation.replacement, operation.matchCase);
        if (text) {
          assertStoredText(text);
          targets[cue.id] = { sourceRevision: cue.sourceRevision, sourceHash: sourceDigest(cue), text, origin: 'human', reviewStatus: 'reviewed' };
          touched.add(cue.id);
        }
        if (touched.size > CUE_EDIT_LIMIT) throw new StudioError('limit_exceeded');
      }
      const undo: SingleCueEditOperation[] = [{ kind: 'revise', sources: oldSources }];
      let stoppedTasks = Object.keys(oldSources).length ? retireResumableTasks(snapshot) : 0;
      if (track && Object.keys(targets).length) {
        const previous = writeEntries(track, targets);
        track.revision++;
        stoppedTasks += retireResumableTasks(snapshot, track.id);
        // Translations go back after the sources, which would otherwise mark them current again.
        undo.push({ kind: 'entries', trackId: track.id, entries: previous });
      }
      applied = { undo: { kind: 'batch', operations: undo }, changed: touched.size, stoppedTasks };
      break;
    }
    case 'merge': {
      const cues = operation.cueIds.map(cueOf);
      const order = cues.map(cue => positions().get(cue.id)!).sort((a, b) => a - b);
      if (order.some((position, index) => index && position !== order[index - 1] + 1)) throw new StudioError('invalid_input');
      const ordered = order.map(position => doc.cues[position]);
      const first = ordered[0], last = ordered.at(-1)!;
      const track = operation.trackId ? trackOf(operation.trackId) : undefined;
      if (operation.target !== undefined && !track) throw new StudioError('invalid_input');
      const undo: SingleCueEditOperation[] = [];
      // The others go first: their entries and nodes are kept for undo by the deletion.
      const removed = deleteCues(snapshot, ordered.slice(1).map(cue => cue.id), cueOf);
      indices = null;
      undo.push(removed.undo as SingleCueEditOperation);
      const before = { startMs: first.timing.startMs, endMs: first.timing.endMs };
      if (writeTiming(first, first.timing.startMs, last.timing.endMs)) undo.push({ kind: 'timing', changes: { [first.id]: before } });
      const oldSource = structuredClone(first.source);
      const oldEntry = track ? structuredClone(track.entries[first.id] ?? null) : null;
      const sourceChanged = JSON.stringify(first.source) !== JSON.stringify(operation.source);
      if (sourceChanged) writeSource(first, operation.source);
      if (track && operation.target !== undefined) {
        if (operation.target === null) delete track.entries[first.id];
        else {
          assertStoredText(operation.target);
          // A stale translation keeps the revision of the source it was made for.
          const made = operation.targetStale ? { sourceRevision: Math.max(1, first.sourceRevision - 1), sourceHash: oldEntry?.sourceHash ?? '' } : { sourceRevision: first.sourceRevision, sourceHash: sourceDigest(first) };
          track.entries[first.id] = { ...made, text: structuredClone(operation.target), origin: operation.origin ?? 'human', reviewStatus: operation.targetStale ? 'unreviewed' : 'reviewed' };
        }
        track.revision++;
      }
      if (sourceChanged || track) undo.push({ kind: 'revise', sources: sourceChanged ? { [first.id]: oldSource } : {}, ...(track ? { trackId: track.id, entries: { [first.id]: oldEntry } } : {}) });
      applied = { undo: { kind: 'batch', operations: undo.reverse() }, changed: ordered.length, stoppedTasks: removed.stoppedTasks + retireResumableTasks(snapshot) };
      break;
    }
  }
  return applied; };

  const results = operations.map(operation => applyOne(operation));
  validateDocument(doc);
  if (results.length === 1) return results[0];
  // Undo runs the inverses backwards; a merge's own undo is already a batch and joins the list in its order.
  const undo: SingleCueEditOperation[] = [];
  for (const result of [...results].reverse()) undo.push(...(result.undo.kind === 'batch' ? result.undo.operations : [result.undo]));
  return { undo: { kind: 'batch', operations: undo }, changed: results.reduce((sum, result) => sum + result.changed, 0), stoppedTasks: results.reduce((sum, result) => sum + result.stoppedTasks, 0) };
}

function deleteCues(snapshot: DocumentSnapshot, cueIds: string[], cueOf: (id: string) => SubtitleCue): AppliedCueEdit {
  const doc = snapshot.document;
  const ids = new Set(cueIds);
  ids.forEach(cueOf);
  // A document keeps at least one cue; deleting the whole document is a separate action.
  if (ids.size >= doc.cues.length) throw new StudioError('invalid_input');
  const removed: RemovedCues = { cues: [], diagnostics: [] };
  doc.cues.forEach((cue, index) => {
    if (!ids.has(cue.id)) return;
    const entries: Record<string, TranslationEntry> = {};
    for (const track of doc.translationTracks) if (track.entries[cue.id]) entries[track.id] = structuredClone(track.entries[cue.id]);
    removed.cues.push({ index, cue: structuredClone(cue), entries });
  });
  (doc as { cues: SubtitleCue[] }).cues = (doc.cues as SubtitleCue[]).filter(cue => !ids.has(cue.id));
  for (const track of doc.translationTracks) {
    if (!cueIds.some(id => track.entries[id])) continue;
    for (const id of cueIds) delete track.entries[id];
    track.revision++;
  }
  if (doc.schemaVersion === 1) {
    const preservation = doc.preservation;
    const touched = new Set(removed.cues.flatMap(({ cue }) => 'importedPair' in cue && cue.importedPair ? [cue.nodeId!, cue.importedPair.target.nodeId] : [cue.nodeId!]));
    for (const node of preservation.nodes) if (node.cueIds.some(id => ids.has(id))) node.cueIds = node.cueIds.filter(id => !ids.has(id));
    const referenced = new Set(doc.cues.flatMap(cue => cue.importedPair ? [cue.nodeId, cue.importedPair.target.nodeId] : [cue.nodeId]));
    const already = new Set(preservation.removedNodeIds);
    const emptied = preservation.nodes.filter(node => touched.has(node.id) && !node.cueIds.length && !referenced.has(node.id) && !already.has(node.id)).map(node => node.id);
    // Exports omit these nodes; the original text stays available for the source download.
    if (emptied.length) preservation.removedNodeIds = [...already, ...emptied];
    const gone = new Set(emptied);
    removed.diagnostics = doc.diagnostics.filter(item => item.nodeId && gone.has(item.nodeId));
    doc.diagnostics = doc.diagnostics.filter(item => !item.nodeId || !gone.has(item.nodeId));
    if (doc.bilingualImport && !doc.cues.some(cue => cue.importedPair)) {
      // No separated pair is left: the document is no longer a bilingual import.
      removed.bilingualImport = doc.bilingualImport;
      removed.importedTrackIds = doc.translationTracks.filter(track => track.origin === 'imported').map(track => track.id);
      delete doc.bilingualImport;
      for (const track of doc.translationTracks) if (track.origin === 'imported') delete track.origin;
    }
  }
  return { undo: { kind: 'restore', removed }, changed: removed.cues.length, stoppedTasks: retireResumableTasks(snapshot) };
}

function restoreCues(snapshot: DocumentSnapshot, removed: RemovedCues): AppliedCueEdit {
  const doc = snapshot.document;
  const existing = new Set(doc.cues.map(cue => cue.id));
  const items = [...removed.cues].sort((a, b) => a.index - b.index);
  if (items.some(item => existing.has(item.cue.id)) || new Set(items.map(item => item.cue.id)).size !== items.length) throw new StudioError('invalid_input');
  // Ascending original positions rebuild the original order.
  const cues = doc.cues as SubtitleCue[];
  for (const item of items) cues.splice(Math.min(item.index, cues.length), 0, structuredClone(item.cue));
  const touchedTracks = new Set<Track>();
  for (const item of items) for (const [trackId, entry] of Object.entries(item.entries)) {
    const track = doc.translationTracks.find(value => value.id === trackId);
    // A track removed since the deletion stays removed.
    if (!track) continue;
    track.entries[item.cue.id] = structuredClone(entry);
    touchedTracks.add(track);
  }
  for (const track of touchedTracks) track.revision++;
  if (doc.schemaVersion === 1) {
    const preservation = doc.preservation;
    const nodes = new Map(preservation.nodes.map(node => [node.id, node]));
    const order = new Map(doc.cues.map((cue, index) => [cue.id, index]));
    for (const item of items) {
      const node = 'nodeId' in item.cue && item.cue.nodeId ? nodes.get(item.cue.nodeId) : undefined;
      if (!node) throw new StudioError('invalid_input');
      node.cueIds = [...node.cueIds, item.cue.id].sort((a, b) => order.get(a)! - order.get(b)!);
    }
    if (removed.bilingualImport && !doc.bilingualImport) {
      doc.bilingualImport = removed.bilingualImport;
      for (const track of doc.translationTracks) if (removed.importedTrackIds?.includes(track.id) && !track.origin) track.origin = 'imported';
    }
    const referenced = new Set(doc.cues.flatMap(cue => cue.importedPair ? [cue.nodeId, cue.importedPair.target.nodeId] : [cue.nodeId]));
    const stillRemoved = (preservation.removedNodeIds ?? []).filter(id => !referenced.has(id) && !nodes.get(id)?.cueIds.length);
    if (stillRemoved.length) preservation.removedNodeIds = stillRemoved;
    else delete preservation.removedNodeIds;
    if (removed.diagnostics.some(item => item.nodeId && !nodes.has(item.nodeId))) throw new StudioError('invalid_input');
    doc.diagnostics.push(...structuredClone(removed.diagnostics));
  } else if (removed.diagnostics.length || removed.bilingualImport) throw new StudioError('invalid_input');
  return { undo: { kind: 'delete', cueIds: items.map(item => item.cue.id) }, changed: items.length, stoppedTasks: retireResumableTasks(snapshot) };
}

export class CueEditService {
  constructor(private repository: DocumentRepository) {}

  async apply(documentId: string, revision: number, operation: CueEditOperation, guard: () => void = () => {}) {
    let applied: AppliedCueEdit | undefined;
    const snapshot = await this.repository.transact(documentId, revision, value => { applied = applyCueEdit(value, operation); }, guard);
    return { snapshot, ...applied! };
  }
}
