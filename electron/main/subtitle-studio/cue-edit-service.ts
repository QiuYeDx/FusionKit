import { StudioError, validateDocument, type SubtitleCue, type SubtitleText, type TranslationEntry } from '../../../src/subtitle-studio/domain';
import { cueEditOperationSchema, storedTextProblem, type CueEditOperation, type RemovedCues } from '../../../src/subtitle-studio/cue-edit-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
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
  const operation = parsed.data;
  const doc = snapshot.document;
  if (snapshot.tasks.some(task => task.status === 'queued' || task.status === 'running')) throw new StudioError('resource_busy');
  const indices = new Map(doc.cues.map((cue, index) => [cue.id, index]));
  const cueOf = (id: string) => {
    const index = indices.get(id);
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

  let applied: AppliedCueEdit;
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
      break;
    case 'restore':
      applied = restoreCues(snapshot, operation.removed);
      break;
  }
  validateDocument(doc);
  return applied;
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
