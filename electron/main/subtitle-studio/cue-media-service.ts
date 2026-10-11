import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, StudioError, type AudioTrack, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { matchSiblingMedia, CUE_AUDIO_LIMITS, type CueMediaStatus, type CueMediaVia } from '../../../src/subtitle-studio/cue-audio';
import type { DocumentRepository } from './document-repository';
import { verifySourceLocation, type SourceLocationRecord } from './source-location-service';
import { localSubtitleFileIdentityForPath, sameLocalSubtitleInputFileIdentity, snapshotLocalSubtitleFileIdentity,
  type LocalSubtitleFileIdentity } from './transcription/native/filesystem-object-identity';

const absolutePath = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const fileIdentity = z.custom<LocalSubtitleFileIdentity>(value => !!snapshotLocalSubtitleFileIdentity(value));
const recordSchema = z.object({ schemaVersion: z.literal(1), documentId: idSchema, originFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mediaPath: absolutePath, mediaIdentity: fileIdentity }).strict();
export type CueMediaRecord = z.infer<typeof recordSchema>;
/** The media the user chose for a document. Private like the source receipt: the path never reaches the renderer. */
export const CUE_MEDIA_FILE = 'cue-media.private.json';

// The same fingerprint as the source receipt: replacing the document's origin drops the choice.
const fingerprint = (doc: SubtitleDocument) => createHash('sha256').update(JSON.stringify(doc.origin)).digest('hex');
export function bindCueMedia(doc: SubtitleDocument, mediaPath: string, mediaIdentity: LocalSubtitleFileIdentity): CueMediaRecord {
  return recordSchema.parse({ schemaVersion: 1, documentId: doc.id, originFingerprint: fingerprint(doc), mediaPath, mediaIdentity });
}
/** Null when the record belongs to another document or an earlier origin. */
export function validateCueMediaRecord(doc: SubtitleDocument, value: unknown): CueMediaRecord | null {
  const record = recordSchema.safeParse(value);
  return record.success && record.data.documentId === doc.id && record.data.originFingerprint === fingerprint(doc) ? record.data : null;
}

/** A file to decode, checked to be the one recorded, and which of its audio streams to play (from 1). */
export type ResolvedCueMedia = { status: CueMediaStatus; media?: { path: string; identity: LocalSubtitleFileIdentity; audioOrdinal: number } };

async function regularFile(filePath: string) {
  const stat = await lstat(filePath);
  if (!stat.isFile()) throw new StudioError('document_unavailable');
  const real = await realpath(filePath);
  if (real !== filePath) throw new StudioError('document_unavailable');
  return localSubtitleFileIdentityForPath(real);
}
async function sameFile(filePath: string, identity: LocalSubtitleFileIdentity) {
  try { return sameLocalSubtitleInputFileIdentity(await regularFile(filePath), identity); } catch { return false; }
}

/**
 * Finds the original media of a document: the file the user chose, else the
 * transcribed file, else one media file named like the imported subtitle in
 * its folder. A recorded file that moved or changed is reported unavailable
 * rather than replaced by another candidate.
 */
export class CueMediaService {
  constructor(private readonly repository: DocumentRepository) {}

  private async sourceRecord(documentId: string): Promise<SourceLocationRecord | null> {
    try { return await this.repository.readSourceLocation(documentId); } catch { return null; }
  }

  async resolve(documentId: string, guard: () => void = () => {}): Promise<ResolvedCueMedia> {
    const doc = (await this.repository.readSnapshot(documentId)).document; guard();
    const linked = await this.repository.readCueMedia(documentId); guard();
    // The track transcribed plays from the transcribed file, and from a file chosen in its place.
    const track = doc.origin.format === 'media' ? doc.origin.audioTrack : undefined;
    const withTrack = track ? { track } : {};
    if (linked) return this.checked('linked', linked.mediaPath, linked.mediaIdentity, guard, track);
    const source = await this.sourceRecord(documentId); guard();
    if (source?.capture.origin !== 'input') return { status: { status: 'missing' } };
    const { inputPath, inputIdentity, directoryPath } = source.capture;
    if (doc.origin.format === 'media') {
      try { await verifySourceLocation(source.capture); guard(); }
      catch { guard(); return { status: { status: 'unavailable', via: 'transcription', name: path.basename(inputPath), ...withTrack } }; }
      return { status: { status: 'ready', via: 'transcription', name: path.basename(inputPath), ...withTrack }, media: { path: inputPath, identity: inputIdentity, audioOrdinal: track?.ordinal ?? 1 } };
    }
    try {
      const folder = await lstat(directoryPath);
      if (!folder.isDirectory() || await realpath(directoryPath) !== directoryPath) return { status: { status: 'missing' } };
      const entries: string[] = [];
      for await (const entry of await opendir(directoryPath)) {
        if (entries.push(entry.name) > CUE_AUDIO_LIMITS.siblingEntries) break;
      }
      guard();
      const name = matchSiblingMedia(path.basename(inputPath), entries);
      if (!name) return { status: { status: 'missing' } };
      const mediaPath = path.join(directoryPath, name);
      const identity = await regularFile(mediaPath); guard();
      return { status: { status: 'ready', via: 'matched', name }, media: { path: mediaPath, identity, audioOrdinal: 1 } };
    } catch {
      guard();
      return { status: { status: 'missing' } };
    }
  }

  private async checked(via: CueMediaVia, mediaPath: string, identity: LocalSubtitleFileIdentity, guard: () => void, track?: AudioTrack): Promise<ResolvedCueMedia> {
    const ok = await sameFile(mediaPath, identity); guard();
    const name = path.basename(mediaPath), withTrack = track ? { track } : {};
    return ok ? { status: { status: 'ready', via, name, ...withTrack }, media: { path: mediaPath, identity, audioOrdinal: track?.ordinal ?? 1 } }
      : { status: { status: 'unavailable', via, name, ...withTrack } };
  }

  async status(documentId: string, guard: () => void = () => {}): Promise<CueMediaStatus> {
    return (await this.resolve(documentId, guard)).status;
  }

  /** Links a file the user picked in the system file dialog. */
  async link(documentId: string, filePath: string, guard: () => void = () => {}): Promise<CueMediaStatus> {
    let mediaPath: string, identity: LocalSubtitleFileIdentity;
    try { mediaPath = await realpath(filePath); identity = await regularFile(mediaPath); }
    catch { guard(); throw new StudioError('invalid_input'); }
    guard();
    await this.repository.setCueMedia(documentId, (doc: SubtitleDocument) => bindCueMedia(doc, mediaPath, identity), guard); guard();
    return this.status(documentId, guard);
  }

  async clear(documentId: string, guard: () => void = () => {}): Promise<CueMediaStatus> {
    await this.repository.setCueMedia(documentId, null, guard); guard();
    return this.status(documentId, guard);
  }

  /**
   * A transcribed document's source receipt names its media. Choosing another
   * folder for exports replaces that receipt, so keep the media as a link first.
   */
  async keepTranscribedMedia(documentId: string, guard: () => void = () => {}) {
    const doc = (await this.repository.readSnapshot(documentId)).document; guard();
    if (doc.origin.format !== 'media' || await this.repository.readCueMedia(documentId)) return;
    const source = await this.sourceRecord(documentId); guard();
    if (source?.capture.origin !== 'input' || !await sameFile(source.capture.inputPath, source.capture.inputIdentity)) return;
    const { inputPath, inputIdentity } = source.capture;
    await this.repository.setCueMedia(documentId, current => bindCueMedia(current, inputPath, inputIdentity), guard);
  }
}
