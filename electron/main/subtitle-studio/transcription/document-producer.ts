import { StudioError } from '../../../../src/subtitle-studio/domain';
import type { TranscriptionExecutor, TranscriptionBatchExecutionContext, TranscriptionTaskExecutionContext,
  TranscriptExecutionResult } from './transcript-executor';
import type { createTranscriptionDocumentSink } from './document-sink';

type Sink = ReturnType<typeof createTranscriptionDocumentSink>;
type Ready = Extract<TranscriptExecutionResult, { status: 'transcript_ready' }>;
type Terminal = Exclude<TranscriptExecutionResult, Ready>;
type Commit = Awaited<ReturnType<Sink['publish']>>;
export type DocumentProductionResult = Terminal | (Commit & Pick<Ready, 'durationMs' | 'cueSummary'>);

/** Internal composition only. Task admission must supply verified media/model/backend contexts. */
export function createTranscriptionDocumentProducer(options: {
  executor: Pick<TranscriptionExecutor, 'beginBatchSlice' | 'execute' | 'endBatchSlice'>;
  sink: Sink;
  batch: TranscriptionBatchExecutionContext;
  task: Omit<TranscriptionTaskExecutionContext, 'batchRuntime'>;
  assertActive: () => void;
}) {
  const { executor, sink, assertActive } = options;
  const batch = Object.freeze({ ...options.batch, owner: Object.freeze({ ...options.batch.owner }) });
  const task = Object.freeze({ ...options.task, owner: Object.freeze({ ...options.task.owner }) });
  const sameOwner = (a: typeof batch.owner, b: typeof batch.owner) =>
    a.webContentsId === b.webContentsId && a.ownerSessionId === b.ownerSessionId;
  if (!sameOwner(batch.owner, task.owner) || !sameOwner(task.owner, sink.identity.owner)
    || task.taskId !== sink.identity.taskId || task.generation !== sink.identity.generation
    || task.batchId !== batch.batchId || task.config !== batch.config
    || task.managedModel !== batch.managedModel || task.managedVad !== batch.managedVad
    || task.backendResolution !== batch.backendResolution
    || task.admittedRuntimeGeneration !== batch.admittedRuntimeGeneration) throw new StudioError('invalid_input');
  const signal = AbortSignal.any([batch.signal, task.signal]);
  let operation: Promise<DocumentProductionResult> | undefined;
  let ready: Ready | undefined;
  let terminal: Terminal | undefined;
  let cleanupFailure: unknown;
  let cleanupFailed = false;

  async function produce(): Promise<DocumentProductionResult> {
    assertActive();
    // An unsuccessful batch release cannot safely be retried on this executor: its
    // native batch record may already be closed. The owning runtime must clean up.
    if (cleanupFailed) throw cleanupFailure;
    if (terminal) return terminal;
    if (!ready) {
      if (signal.aborted) return terminal = Object.freeze({ status: 'cancelled' });
      const runtime = executor.beginBatchSlice({ ...batch, signal });
      let result: TranscriptExecutionResult | undefined;
      let executionFailure: unknown;
      let executionFailed = false;
      try { result = await executor.execute({ ...task, batchRuntime: runtime, signal }); }
      catch (error) { executionFailed = true; executionFailure = error; }
      try { await executor.endBatchSlice(runtime); }
      catch (error) {
        cleanupFailed = true;
        cleanupFailure = executionFailed
          ? new AggregateError([executionFailure, error], 'Transcription execution and batch cleanup failed.') : error;
        throw cleanupFailure;
      }
      if (executionFailed) throw executionFailure;
      if (result!.status !== 'transcript_ready') return terminal = result as Terminal;
      ready = result as Ready;
    }
    // The repository guard checks again at publication. Once published, its
    // receipt wins over late cancellation; no after-commit guard reverses it.
    assertActive();
    const receipt = await sink.publish(ready.transcript, { signal });
    return Object.freeze({ ...receipt, ...(ready.durationMs === undefined ? {} : { durationMs: ready.durationMs }),
      cueSummary: ready.cueSummary });
  }

  return Object.freeze({
    documentId: sink.documentId,
    run(): Promise<DocumentProductionResult> {
      if (operation) return operation;
      operation = produce().finally(() => { operation = undefined; });
      return operation;
    },
  });
}
