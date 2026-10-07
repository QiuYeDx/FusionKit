import { app, dialog, ipcMain, BrowserWindow, type IpcMain } from "electron";
import path from "node:path";
import type { ZodType } from "zod";
import {
  NAME_TRANSLATION_CHANNELS,
  cancelTranslateRequestSchema,
  directoryRequestSchema,
  inspectPathsRequestSchema,
  journalRequestSchema,
  renameItemsRequestSchema,
  selectPathsRequestSchema,
  translateRequestSchema,
  type NameTranslationError,
  type NameTranslationIpcResult,
} from "@/name-translation/contract";
import { applyRenames, undoJournal, type ExecutorDeps } from "./executor";
import {
  collectDescendants,
  defaultPlatformContext,
  inspectPaths,
  listDirectory,
} from "./fs-listing";
import { NameJournalStore } from "./journal";
import { planRename } from "./planner";
import { classifyTranslationError, translateNames, type SendModelText } from "./translator";

export interface NameTranslationIpcOptions {
  readonly ipc?: Pick<IpcMain, "handle">;
  readonly journalDir?: string;
  readonly sendModelText?: SendModelText;
  readonly showOpenDialog?: (
    options: Electron.OpenDialogOptions,
  ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  readonly executor?: Partial<Omit<ExecutorDeps, "journals">>;
}

function ok<T>(data: T): NameTranslationIpcResult<T> {
  return { ok: true, data };
}

function fail(error: NameTranslationError): NameTranslationIpcResult<never> {
  return { ok: false, error };
}

export function setupNameTranslationIPC(options: NameTranslationIpcOptions = {}): void {
  const ipc = options.ipc ?? ipcMain;
  const journals = new NameJournalStore(
    options.journalDir ?? path.join(app.getPath("userData"), "name-translation", "journals"),
  );
  const executorDeps: ExecutorDeps = { ...options.executor, journals };
  const translations = new Map<string, Set<AbortController>>();
  let mutationBusy = false;

  const handle = <T>(
    channel: string,
    schema: ZodType<T> | null,
    run: (request: T) => Promise<NameTranslationIpcResult<unknown>>,
  ) => {
    ipc.handle(channel, async (_event, payload: unknown) => {
      let request = payload as T;
      if (schema) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          return fail({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid request." });
        }
        request = parsed.data;
      }
      try {
        return await run(request);
      } catch (error) {
        return fail({ code: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const exclusive = async <T>(run: () => Promise<NameTranslationIpcResult<T>>) => {
    if (mutationBusy) {
      return fail({ code: "busy", message: "Another rename is still running." });
    }
    mutationBusy = true;
    try {
      return await run();
    } finally {
      mutationBusy = false;
    }
  };

  handle(NAME_TRANSLATION_CHANNELS.selectPaths, selectPathsRequestSchema, async (request) => {
    const show =
      options.showOpenDialog ??
      ((dialogOptions: Electron.OpenDialogOptions) => {
        const owner = BrowserWindow.getFocusedWindow();
        return owner ? dialog.showOpenDialog(owner, dialogOptions) : dialog.showOpenDialog(dialogOptions);
      });
    const result = await show({
      ...(request.title ? { title: request.title } : {}),
      properties: [request.kind === "directory" ? "openDirectory" : "openFile", "multiSelections"],
    });
    return ok({ canceled: result.canceled, paths: result.canceled ? [] : result.filePaths });
  });

  handle(NAME_TRANSLATION_CHANNELS.inspectPaths, inspectPathsRequestSchema, async (request) =>
    ok(await inspectPaths(request.paths, request.source, defaultPlatformContext())),
  );

  handle(NAME_TRANSLATION_CHANNELS.listDirectory, directoryRequestSchema, async (request) =>
    ok(await listDirectory(request.path, request.includeHidden)),
  );

  handle(NAME_TRANSLATION_CHANNELS.collectDescendants, directoryRequestSchema, async (request) =>
    ok(await collectDescendants(request.path, request.includeHidden)),
  );

  handle(NAME_TRANSLATION_CHANNELS.translate, translateRequestSchema, async (request) => {
    const controller = new AbortController();
    const active = translations.get(request.requestId) ?? new Set<AbortController>();
    active.add(controller);
    translations.set(request.requestId, active);
    try {
      return ok(await translateNames(request, controller.signal, options.sendModelText));
    } catch (error) {
      return fail(controller.signal.aborted ? { code: "cancelled", message: "Translation was cancelled." } : classifyTranslationError(error));
    } finally {
      active.delete(controller);
      if (active.size === 0) translations.delete(request.requestId);
    }
  });

  handle(NAME_TRANSLATION_CHANNELS.cancelTranslate, cancelTranslateRequestSchema, async (request) => {
    const active = translations.get(request.requestId);
    active?.forEach((controller) => controller.abort());
    return ok({ cancelled: Boolean(active?.size) });
  });

  handle(NAME_TRANSLATION_CHANNELS.preflight, renameItemsRequestSchema, async (request) =>
    ok((await planRename(request.items, executorDeps)).preflight),
  );

  handle(NAME_TRANSLATION_CHANNELS.apply, renameItemsRequestSchema, (request) =>
    exclusive(async () => ok(await applyRenames(request.items, executorDeps))),
  );

  handle(NAME_TRANSLATION_CHANNELS.undo, journalRequestSchema, (request) =>
    exclusive(async () => {
      const result = await undoJournal(request.journalId, executorDeps);
      return result ? ok(result) : fail({ code: "journal_not_found", message: "Rename record not found." });
    }),
  );

  handle(NAME_TRANSLATION_CHANNELS.listJournals, null, async () =>
    ok({ journals: await journals.list() }),
  );

  handle(NAME_TRANSLATION_CHANNELS.dismissJournal, journalRequestSchema, (request) =>
    exclusive(async () => {
      const record = await journals.read(request.journalId);
      if (!record) return fail({ code: "journal_not_found", message: "Rename record not found." });
      const writer = await journals.openForAppend(request.journalId);
      try {
        await writer.status("dismissed");
      } finally {
        await writer.close();
      }
      return ok({ dismissed: true });
    }),
  );
}
