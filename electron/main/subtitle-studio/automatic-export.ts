import path from 'node:path';
import { StudioError, type ErrorCode } from '../../../src/subtitle-studio/domain';
import { resolveAutomaticExportFormat } from '../../../src/subtitle-studio/automatic-export-contract';
import type { ExportOptions } from '../../../src/subtitle-studio/export-contract';
import type { DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import type { DocumentRepository } from './document-repository';
import { planSubtitleExport } from './export-planner';
import { publishBytes } from './export-service';
import { SourceLocationService } from './source-location-service';
import { publishTransaction } from './translation-recovery';

/** The export a durable spec asks for, against the translation track its automatic translation wrote. */
export function automaticExportOptions(snapshot: DocumentSnapshot): ExportOptions | undefined {
  const pending = snapshot.automaticExport;
  if (pending?.state !== 'pending') return undefined;
  const { spec } = pending;
  const track = spec.mode === 'source' ? undefined
    : snapshot.tasks.find(task => task.id === snapshot.automaticTranslation?.translationTaskId)?.trackId;
  if (spec.mode !== 'source' && !track) return undefined;
  return { mode: spec.mode, format: resolveAutomaticExportFormat(spec, snapshot.document.origin), ...(track ? { trackId: track } : {}),
    order: spec.order, conflictPolicy: spec.conflictPolicy, fileNameSuffix: { mode: 'none' }, stripMediaExt: true,
    encoding: 'utf-8', bom: false, newline: 'lf',
    // Nothing waits for a person here: untranslated cues keep their source text and a missing end
    // runs to the next cue, rather than stopping the whole export.
    incomplete: 'source-fallback', missingEnd: { mode: 'next-start', finalDurationMs: 2000 } };
}

/**
 * Writes a document next to its source media once its pipeline is done, with the format and content
 * chosen when the work was submitted. Runs in main without a picker: transcripts are bound to their
 * source location when they are created. The outcome is kept on the document.
 */
export function createAutomaticExporter(repository: DocumentRepository) {
  const sources = new SourceLocationService(repository);
  const running = new Map<string, Promise<void>>();
  const record = async (documentId: string, outcome: { fileName: string } | { error: ErrorCode }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = await repository.readSnapshot(documentId);
        if (current.automaticExport?.state !== 'pending') return;
        await publishTransaction(repository, documentId, current.document.revision, value => {
          if (value.automaticExport?.state !== 'pending') return;
          value.automaticExport = 'fileName' in outcome
            ? { spec: value.automaticExport.spec, state: 'exported', fileName: outcome.fileName }
            : { spec: value.automaticExport.spec, state: 'failed', error: outcome.error };
        });
        return;
      } catch (error) {
        // An edit landing between the read and the write moves the revision; read again.
        if (!(error instanceof StudioError) || error.code !== 'revision_conflict') return;
      }
    }
  };
  const run = async (documentId: string) => {
    let snapshot: DocumentSnapshot;
    try { snapshot = await repository.readSnapshot(documentId); } catch { return; }
    const options = automaticExportOptions(snapshot);
    if (!options) return;
    try {
      const plan = planSubtitleExport(snapshot.document, options);
      if (!plan.bytes) throw new StudioError('invalid_input');
      const location = await sources.inspect(documentId);
      if (location.summary.status !== 'ready') throw new StudioError(location.summary.status === 'missing' ? 'needs_configuration' : 'document_unavailable');
      const policy = options.conflictPolicy ?? 'indexed';
      const output = await sources.publish(documentId, location.bindingId,
        (directory, verify) => publishBytes(plan.bytes!, path.join(directory, plan.fileName), verify, policy), () => {}, undefined, policy === 'overwrite');
      await record(documentId, { fileName: path.basename(output) });
    } catch (error) {
      await record(documentId, { error: error instanceof StudioError ? error.code : 'output_write_failed' });
    }
  };
  return Object.freeze({
    /** Export a document whose pipeline just finished; concurrent calls for one document share a run. */
    exportDocument(documentId: string): Promise<void> {
      const existing = running.get(documentId);
      if (existing) return existing;
      const operation = run(documentId).finally(() => { if (running.get(documentId) === operation) running.delete(documentId); });
      running.set(documentId, operation);
      return operation;
    },
    settled: () => Promise.allSettled([...running.values()]).then(() => undefined),
  });
}
export type AutomaticExporter = ReturnType<typeof createAutomaticExporter>;
