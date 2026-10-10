import useAgentStore from "@/store/agent/useAgentStore";
import { getStudioTranscriptionController } from "@/services/subtitle-studio/transcription-controller";
import type { DocumentSummary } from "@/subtitle-studio/ipc-contract";
import type { TranscriptionTaskSummary } from "@/subtitle-studio/transcription/task-contract";
import type { AgentUiEvent } from "./types";

// ---------------------------------------------------------------------------
// A transcription batch the assistant submitted with automatic translation or
// export runs on in main without it. This watches the batch and reports once,
// when every file has gone as far as it will, so the assistant can sum up.
// ---------------------------------------------------------------------------

const TRANSCRIBING = new Set(["queued", "preparing_media", "loading_model", "transcribing", "post_processing"]);
const TRANSLATING = new Set(["queued", "running"]);

export interface PipelineScope { translate: boolean; exportFiles: boolean; removeAfterExport?: boolean }

/** Whether every file of the batch is through, and what to report when it is. */
export function pipelineOutcome(tasks: readonly TranscriptionTaskSummary[], documents: ReadonlyMap<string, DocumentSummary>, scope: PipelineScope): AgentUiEvent | null {
  const written: string[] = [], problems: string[] = [];
  let finished = 0, removed = 0;
  for (const task of tasks) {
    if (TRANSCRIBING.has(task.status)) return null;
    if (task.status !== "completed" || !task.documentId) { problems.push(`${task.displayName}: ${task.error?.code ?? task.status}`); continue; }
    if (!scope.translate && !scope.exportFiles) { finished++; continue; }
    const document = documents.get(task.documentId);
    // A document is only removed after its file was written, so a missing one is a finished one.
    if (!document && scope.exportFiles && scope.removeAfterExport) { removed++; finished++; continue; }
    if (!document) return null;
    if (scope.translate) {
      const handoff = task.automaticTranslation?.status;
      if (handoff === "pending" || (handoff === "admitted" && (!document.task || TRANSLATING.has(document.task.status)))) return null;
      if (handoff !== "admitted" || document.task?.status !== "completed") {
        problems.push(`${task.displayName}: ${handoff === "admitted" ? document.task?.status : "translation_not_started"}`); continue;
      }
    }
    if (scope.exportFiles) {
      const output = document.automaticExport;
      if (!output || output.state === "pending") return null;
      if (output.state === "failed") { problems.push(`${task.displayName}: export ${output.error ?? "failed"}`); continue; }
      written.push(output.fileName!);
    }
    finished++;
  }
  return { kind: "pipeline_completed", values: { total: tasks.length, finished, failed: tasks.length - finished, ...(removed ? { removed } : {}),
    files: written.slice(0, 8).join(", ") + (written.length > 8 ? ` (+${written.length - 8})` : ""),
    problems: problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` (+${problems.length - 5})` : "") } };
}

async function readDocuments(ids: ReadonlySet<string>): Promise<Map<string, DocumentSummary>> {
  const found = new Map<string, DocumentSummary>();
  if (!ids.size || typeof window === "undefined" || !window.subtitleStudio) return found;
  for (let offset = 0, page = 0; page < 50 && found.size < ids.size; page++) {
    const response = await window.subtitleStudio.listDocuments({ offset, pageSize: 100, sort: "recent" });
    if (!response.ok) break;
    for (const document of response.value.documents) if (ids.has(document.id)) found.set(document.id, document);
    offset += response.value.documents.length;
    if (!response.value.documents.length || offset >= response.value.total) break;
  }
  return found;
}

const INTERVAL_MS = 4000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Follow one submitted batch until it is through, then report it to the assistant once. */
export function watchStudioPipeline(input: PipelineScope & { sessionId: string; taskIds: readonly string[] }): () => void {
  const ids = new Set(input.taskIds);
  const started = Date.now();
  let stopped = false, busy = false;
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  const stop = () => { stopped = true; clearInterval(timer); };
  async function tick() {
    if (stopped || busy) return;
    if (useAgentStore.getState().session.id !== input.sessionId || Date.now() - started > GIVE_UP_MS) { stop(); return; }
    busy = true;
    try {
      const tasks = getStudioTranscriptionController().getState().tasks.filter(task => ids.has(task.taskId));
      if (tasks.length !== ids.size || tasks.some(task => TRANSCRIBING.has(task.status))) return;
      const documents = await readDocuments(new Set(tasks.flatMap(task => task.documentId ? [task.documentId] : [])));
      const event = pipelineOutcome(tasks, documents, input);
      if (!event || stopped || useAgentStore.getState().session.id !== input.sessionId) return;
      stop();
      // Loaded on use: the orchestrator owns the tools that start this watch.
      const { reportUiEvent } = await import("./orchestrator");
      reportUiEvent(event);
    } catch { /* The next tick reads again. */ }
    finally { busy = false; }
  }
  return stop;
}
