import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema, StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import type { SourceLocationSummary } from '../../../src/subtitle-studio/export-contract';
import type { DocumentRepository } from './document-repository';
import { localSubtitleFileIdentityForPath, localSubtitleFilesystemObjectIdentityForPath, sameLocalSubtitleInputFileIdentity,
  sameLocalSubtitleFilesystemObjectIdentity, snapshotLocalSubtitleFileIdentity, snapshotLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFileIdentity, type LocalSubtitleFilesystemObjectIdentity } from './transcription/native/filesystem-object-identity';

const absolutePath = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && !value.includes('\0'));
const objectIdentity = z.custom<LocalSubtitleFilesystemObjectIdentity>(value => !!snapshotLocalSubtitleFilesystemObjectIdentity(value));
const fileIdentity = z.custom<LocalSubtitleFileIdentity>(value => !!snapshotLocalSubtitleFileIdentity(value));
const directoryFields = { directoryPath: absolutePath, directoryIdentity: objectIdentity };
export const sourceLocationCaptureSchema = z.discriminatedUnion('origin', [
  z.object({ origin: z.literal('input'), ...directoryFields, inputPath: absolutePath, inputIdentity: fileIdentity }).strict(),
  z.object({ origin: z.literal('user-selected-directory'), ...directoryFields }).strict(),
]);
export type SourceLocationCapture = z.infer<typeof sourceLocationCaptureSchema>;
const recordSchema = z.object({ schemaVersion: z.literal(1), documentId: idSchema, bindingId: idSchema,
  originFingerprint: z.string().regex(/^[a-f0-9]{64}$/), capture: sourceLocationCaptureSchema }).strict();
export type SourceLocationRecord = z.infer<typeof recordSchema>;
export const SOURCE_LOCATION_FILE = 'source-location.private.json';

const fingerprint = (doc: SubtitleDocument) => createHash('sha256').update(JSON.stringify(doc.origin)).digest('hex');
export function bindSourceLocation(doc: SubtitleDocument, capture: SourceLocationCapture): SourceLocationRecord {
  return validateSourceLocationRecord(doc, { schemaVersion: 1, documentId: doc.id, bindingId: randomUUID(), originFingerprint: fingerprint(doc), capture });
}
export function validateSourceLocationRecord(doc: SubtitleDocument, value: unknown): SourceLocationRecord {
  const record = recordSchema.safeParse(value);
  if (!record.success || record.data.documentId !== doc.id || record.data.originFingerprint !== fingerprint(doc)) throw new StudioError('output_write_failed');
  return record.data;
}
const unavailable = () => new StudioError('output_write_failed');
async function directoryIdentityAt(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw unavailable();
  return localSubtitleFilesystemObjectIdentityForPath(directory);
}
/** These values are private receipts, never renderer capabilities or public document fields. */
export async function captureSourceInput(filePath: string, expectedInput?: LocalSubtitleFileIdentity,
  expectedDirectory?: LocalSubtitleFilesystemObjectIdentity): Promise<SourceLocationCapture> {
  try {
    if (!(await lstat(filePath)).isFile()) throw unavailable();
    const inputPath = await realpath(filePath), directoryPath = path.dirname(inputPath);
    const inputIdentity = await localSubtitleFileIdentityForPath(inputPath);
    if (expectedInput && !sameLocalSubtitleInputFileIdentity(expectedInput, inputIdentity)) throw unavailable();
    const directoryIdentity = await directoryIdentityAt(directoryPath);
    if (expectedDirectory && !sameLocalSubtitleFilesystemObjectIdentity(expectedDirectory, directoryIdentity)) throw unavailable();
    const capture = sourceLocationCaptureSchema.parse({ origin: 'input', inputPath, inputIdentity, directoryPath, directoryIdentity });
    await verifySourceLocation(capture);
    return capture;
  } catch { throw unavailable(); }
}
export async function captureSourceDirectory(directory: string): Promise<SourceLocationCapture> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw unavailable();
    const directoryPath = await realpath(directory);
    const capture: SourceLocationCapture = { origin: 'user-selected-directory', directoryPath, directoryIdentity: await directoryIdentityAt(directoryPath) };
    await verifySourceLocation(capture); return capture;
  } catch { throw unavailable(); }
}
/** Recheck both relations twice. This is bounded path validation, not a claim of dirfd-relative I/O. */
export async function verifySourceLocation(value: SourceLocationCapture): Promise<void> {
  try {
    const capture = sourceLocationCaptureSchema.parse(value);
    for (let round = 0; round < 2; round++) {
      if (capture.origin === 'input') {
        if (path.dirname(capture.inputPath) !== capture.directoryPath || !(await lstat(capture.inputPath)).isFile()
          || await realpath(capture.inputPath) !== capture.inputPath
          || !sameLocalSubtitleInputFileIdentity(await localSubtitleFileIdentityForPath(capture.inputPath), capture.inputIdentity)) throw unavailable();
      }
      if (!sameLocalSubtitleFilesystemObjectIdentity(await directoryIdentityAt(capture.directoryPath), capture.directoryIdentity)) throw unavailable();
    }
  } catch { throw unavailable(); }
}

export class SourceLocationService {
  constructor(private readonly repository: DocumentRepository) {}
  async inspect(documentId: string, guard: () => void = () => {}): Promise<{ summary: SourceLocationSummary; bindingId?: string }> {
    let record: SourceLocationRecord | null;
    try { record = await this.repository.readSourceLocation(documentId); guard(); }
    catch (error) { guard(); if (error instanceof StudioError && error.code === 'output_write_failed') return { summary: { status: 'unavailable' } }; throw error; }
    if (!record) return { summary: { status: 'missing' } };
    try { await verifySourceLocation(record.capture); guard(); return { summary: { status: 'ready', origin: record.capture.origin }, bindingId: record.bindingId }; }
    catch { guard(); return { summary: { status: 'unavailable', origin: record.capture.origin }, bindingId: record.bindingId }; }
  }
  async get(documentId: string, guard: () => void = () => {}): Promise<SourceLocationSummary> { return (await this.inspect(documentId, guard)).summary; }
  async selectDirectory(documentId: string, directory: string, guard: () => void = () => {}): Promise<SourceLocationSummary> {
    const capture = await captureSourceDirectory(directory); guard();
    await this.repository.setSourceLocation(documentId, capture, guard); guard();
    return { status: 'ready', origin: 'user-selected-directory' };
  }
  async publish<T>(documentId: string, bindingId: string | undefined,
    action: (directory: string, verify: () => Promise<void>) => Promise<T>, guard: () => void = () => {}, revision?: number): Promise<T> {
    if (!bindingId) throw new StudioError('needs_configuration');
    return this.repository.withSourceLocation(documentId, bindingId, async record => {
      const verify = async () => { guard(); await verifySourceLocation(record.capture); guard(); };
      await verify();
      return action(record.capture.directoryPath, verify);
    }, revision);
  }
}
