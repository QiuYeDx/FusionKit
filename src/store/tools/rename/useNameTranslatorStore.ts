import { create } from "zustand";
import type {
  NameDirectoryListing,
  NameEntry,
  NameInspectRejection,
  NameJournalSummary,
  NamePreflightResult,
  NameRenameItem,
  NameRenamedEntry,
  NameTranslationError,
  NameUnrecoveredEntry,
} from "@/name-translation/contract";
import { getNameTranslationApi, rendererPlatform, toRuntimeModel, unwrap } from "@/services/name-translation/api";
import { translateTargets } from "@/services/name-translation/translate";
import { getTemplateError } from "@/name-translation/naming-rules";
import {
  computeRowStates,
  remapPath,
  settingsKeyOf,
  suggestNumberedNames,
  type DirectoryState,
  type Proposal,
  type RowFilter,
  type ServerIssue,
  type WorkspaceData,
} from "@/services/name-translation/workspace";
import useModelStore from "@/store/useModelStore";
import useNameTranslatorConfigStore, { resolveNameTemplate } from "./nameTranslatorConfig";

export type SelectInsideMode = "all" | "files" | "folders" | "children" | "none";
export type SelectAllMode = "everything" | "files" | "folders" | "roots" | "none";

export interface TranslationRun {
  readonly requestId: string;
  readonly total: number;
  readonly done: number;
}

export interface ConfirmState {
  readonly items: readonly NameRenameItem[];
  readonly names: Readonly<Record<string, string>>;
  /** Selected entries that will keep their names, by reason. */
  readonly skipped: { readonly untranslated: number; readonly issues: number; readonly unchanged: number };
  readonly error?: string;
}

export type RenameOutcome =
  | {
      readonly kind: "completed";
      readonly journalId: string;
      readonly renamed: readonly NameRenamedEntry[];
      readonly undoState?: "running" | "done" | "partial";
      readonly undoFailures?: readonly NameUnrecoveredEntry[];
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly failedPath: string;
      readonly rollback: "complete" | "partial";
      readonly unrecovered: readonly NameUnrecoveredEntry[];
      readonly journalId?: string;
    };

export interface NameTranslatorState extends WorkspaceData {
  expanded: Record<string, true>;
  filter: RowFilter;
  rejected: NameInspectRejection[];
  notice: { kind: "truncated"; path: string } | null;
  adding: boolean;
  collecting: Record<string, true>;
  run: TranslationRun | null;
  translationError: NameTranslationError | null;
  preparing: boolean;
  confirm: ConfirmState | null;
  applying: boolean;
  outcome: RenameOutcome | null;
  recovery: NameJournalSummary[];
  recoveryBusy: string | null;

  addPaths: (paths: readonly string[], source: "picker" | "drop" | "agent") => Promise<void>;
  removeRoot: (path: string) => void;
  clearWorkspace: () => void;
  setFilter: (filter: RowFilter) => void;
  toggleExpanded: (path: string) => void;
  reloadDirectories: () => Promise<void>;
  toggleChecked: (path: string) => void;
  setChecked: (paths: readonly string[], checked: boolean) => void;
  selectInside: (path: string, mode: SelectInsideMode) => Promise<void>;
  selectAll: (mode: SelectAllMode) => Promise<void>;
  translate: (scope: "needed" | "all" | readonly string[]) => Promise<void>;
  stopTranslation: () => void;
  editName: (path: string, name: string) => void;
  resetName: (path: string) => void;
  applyNumbering: () => void;
  prepareRename: () => Promise<void>;
  cancelConfirm: () => void;
  confirmRename: () => Promise<void>;
  undoLast: () => Promise<void>;
  dismissOutcome: () => void;
  loadRecovery: () => Promise<void>;
  resolveRecovery: (journalId: string, action: "undo" | "dismiss") => Promise<void>;
  loadSession: (session: {
    entries: readonly NameEntry[];
    roots: readonly string[];
    listings: readonly NameDirectoryListing[];
    checked: readonly string[];
    proposals: Readonly<Record<string, Proposal>>;
  }) => void;
}

const EMPTY_WORKSPACE = {
  roots: [] as string[],
  entries: {} as Record<string, NameEntry>,
  dirs: {} as Record<string, DirectoryState>,
  checked: {} as Record<string, true>,
  proposals: {} as Record<string, Proposal>,
  serverIssues: {} as Record<string, ServerIssue>,
  expanded: {} as Record<string, true>,
};

function normalizeKey(value: string, platform: string): string {
  const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

function isInside(candidate: string, parent: string, platform: string): boolean {
  const child = normalizeKey(candidate, platform);
  const base = normalizeKey(parent, platform);
  return child !== base && child.startsWith(`${base}/`);
}

function samePath(left: string, right: string, platform: string): boolean {
  return normalizeKey(left, platform) === normalizeKey(right, platform);
}

function parentOf(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index <= 0) return trimmed;
  const parent = trimmed.slice(0, index);
  // Keep drive roots such as "C:\" intact.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[index]}` : parent;
}

/** Folders from `root` down to the parent of `target`, outermost first. */
function ancestorsBetween(root: string, target: string, platform: string): string[] {
  const chain: string[] = [];
  let current = parentOf(target);
  for (let guard = 0; guard < 512; guard += 1) {
    const isRoot = samePath(current, root, platform);
    if (!isRoot && !isInside(current, root, platform)) break;
    chain.unshift(current);
    if (isRoot) break;
    const next = parentOf(current);
    if (next === current) break;
    current = next;
  }
  return chain;
}

function newRequestId(): string {
  return `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentSettings() {
  const config = useNameTranslatorConfigStore.getState().config;
  return {
    config,
    settingsKey: settingsKeyOf(config),
    template: resolveNameTemplate(config),
    platform: rendererPlatform(),
  };
}

export function selectRowStates(state: WorkspaceData) {
  const settings = currentSettings();
  return computeRowStates(state, settings);
}

const useNameTranslatorStore = create<NameTranslatorState>()((set, get) => {
  const mergeListing = (listing: NameDirectoryListing) => {
    set((state) => {
      const entries = { ...state.entries };
      for (const entry of listing.entries) entries[entry.path] = entry;
      return {
        entries,
        dirs: {
          ...state.dirs,
          [listing.path]: listing.error
            ? { status: "error", children: [], truncated: false, error: listing.error }
            : { status: "loaded", children: listing.entries.map((entry) => entry.path), truncated: listing.truncated },
        },
      };
    });
  };

  const loadDirectory = async (path: string) => {
    set((state) => ({
      dirs: { ...state.dirs, [path]: { status: "loading", children: state.dirs[path]?.children ?? [], truncated: false } },
    }));
    try {
      const listing = await unwrap(
        getNameTranslationApi().listDirectory({
          path,
          includeHidden: useNameTranslatorConfigStore.getState().config.includeHidden,
        }),
      );
      mergeListing({ ...listing, path });
    } catch (error) {
      set((state) => ({
        dirs: {
          ...state.dirs,
          [path]: { status: "error", children: [], truncated: false, error: error instanceof Error ? error.message : String(error) },
        },
      }));
    }
  };

  const collect = async (path: string) => {
    set((state) => ({ collecting: { ...state.collecting, [path]: true } }));
    try {
      const result = await unwrap(
        getNameTranslationApi().collectDescendants({
          path,
          includeHidden: useNameTranslatorConfigStore.getState().config.includeHidden,
        }),
      );
      result.directories.forEach(mergeListing);
      if (result.truncated) set({ notice: { kind: "truncated", path } });
      return result.directories.flatMap((listing) => listing.entries.map((entry) => entry.path));
    } finally {
      set((state) => {
        const collecting = { ...state.collecting };
        delete collecting[path];
        return { collecting };
      });
    }
  };

  /** Reload roots and expanded folders after paths changed on disk. */
  const rebuild = async (
    roots: readonly string[],
    expanded: readonly string[],
  ) => {
    set({ ...EMPTY_WORKSPACE, filter: "all", confirm: null });
    if (roots.length === 0) return;
    const inspected = await unwrap(getNameTranslationApi().inspectPaths({ paths: roots, source: "picker" })).catch(
      () => ({ entries: [], rejected: [] }),
    );
    const entries: Record<string, NameEntry> = {};
    inspected.entries.forEach((entry) => (entries[entry.path] = entry));
    const nextExpanded: Record<string, true> = {};
    expanded.forEach((path) => (nextExpanded[path] = true));
    set({ roots: inspected.entries.map((entry) => entry.path), entries, expanded: nextExpanded });
    // Parents first so children land in already-loaded folders.
    const ordered = [...expanded].sort((left, right) => left.length - right.length);
    await Promise.all(ordered.map((path) => loadDirectory(path)));
  };

  const remapAndRebuild = async (
    renamed: readonly { from: string; to: string }[],
    keepUnrenamed = false,
  ) => {
    const platform = rendererPlatform();
    const state = get();
    const roots = [...new Set(state.roots.map((root) => remapPath(root, renamed, platform)))];
    const expanded = Object.keys(state.expanded).map((path) => remapPath(path, renamed, platform));
    // Entries that were selected but skipped (problems, untranslated) keep their
    // selection and proposal at their new location so they can be fixed next.
    const done = new Set(renamed.map((entry) => entry.from));
    const carry = <T,>(record: Record<string, T>) =>
      keepUnrenamed
        ? Object.fromEntries(
            Object.entries(record)
              .filter(([path]) => !done.has(path))
              .map(([path, value]) => [remapPath(path, renamed, platform), value]),
          )
        : {};
    const checked = carry(state.checked) as Record<string, true>;
    const proposals = carry(state.proposals);
    await rebuild(roots, expanded);
    set({ checked, proposals });
    const loaded = get().dirs;
    const parents = [...new Set(Object.keys(checked).map(parentOf))].filter(
      (parent) => !loaded[parent] && roots.some((root) => isInside(parent, root, platform) || samePath(parent, root, platform)),
    );
    await Promise.all(parents.sort((left, right) => left.length - right.length).map((parent) => loadDirectory(parent)));
  };

  return {
    ...EMPTY_WORKSPACE,
    filter: "all",
    rejected: [],
    notice: null,
    adding: false,
    collecting: {},
    run: null,
    translationError: null,
    preparing: false,
    confirm: null,
    applying: false,
    outcome: null,
    recovery: [],
    recoveryBusy: null,

    addPaths: async (paths, source) => {
      if (paths.length === 0) return;
      set({ adding: true });
      try {
        const result = await unwrap(getNameTranslationApi().inspectPaths({ paths, source }));
        const platform = rendererPlatform();
        const toLoad: string[] = [];
        set((state) => {
          let roots = [...state.roots];
          const entries = { ...state.entries };
          const checked = { ...state.checked };
          const expanded = { ...state.expanded };
          for (const entry of result.entries) {
            entries[entry.path] = entry;
            checked[entry.path] = true;
            const containingRoot = roots.find((root) => isInside(entry.path, root, platform));
            if (containingRoot) {
              for (const dir of ancestorsBetween(containingRoot, entry.path, platform)) {
                if (!expanded[dir]) {
                  expanded[dir] = true;
                  toLoad.push(dir);
                }
              }
              continue;
            }
            if (roots.some((root) => root === entry.path)) continue;
            roots = roots.filter((root) => !isInside(root, entry.path, platform));
            roots.push(entry.path);
            if (entry.kind === "directory" && !entry.symlink) {
              expanded[entry.path] = true;
              toLoad.push(entry.path);
            }
          }
          return { roots, entries, checked, expanded, rejected: [...result.rejected], outcome: state.outcome };
        });
        await Promise.all(
          [...new Set(toLoad)]
            .filter((path) => get().dirs[path]?.status !== "loaded")
            .sort((left, right) => left.length - right.length)
            .map((path) => loadDirectory(path)),
        );
      } catch (error) {
        set({
          rejected: paths.map((path) => ({ path, reason: "unreadable" as const })),
          translationError: error instanceof Error ? { code: "internal", message: error.message } : null,
        });
      } finally {
        set({ adding: false });
      }
    },

    removeRoot: (path) =>
      set((state) => {
        const platform = rendererPlatform();
        const drop = (key: string) => key === path || isInside(key, path, platform);
        const filterRecord = <T,>(record: Record<string, T>) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key))) as Record<string, T>;
        return {
          roots: state.roots.filter((root) => root !== path),
          checked: filterRecord(state.checked),
          proposals: filterRecord(state.proposals),
          serverIssues: filterRecord(state.serverIssues),
          expanded: filterRecord(state.expanded),
        };
      }),

    clearWorkspace: () => {
      get().stopTranslation();
      set({ ...EMPTY_WORKSPACE, rejected: [], notice: null, filter: "all", confirm: null, translationError: null });
    },

    setFilter: (filter) => set({ filter }),

    toggleExpanded: (path) => {
      const state = get();
      if (state.expanded[path]) {
        const expanded = { ...state.expanded };
        delete expanded[path];
        set({ expanded });
        return;
      }
      set({ expanded: { ...state.expanded, [path]: true } });
      if (state.dirs[path]?.status !== "loaded") void loadDirectory(path);
    },

    reloadDirectories: async () => {
      const loaded = Object.entries(get().dirs)
        .filter(([, dir]) => dir.status !== "loading")
        .map(([path]) => path)
        .sort((left, right) => left.length - right.length);
      await Promise.all(loaded.map((path) => loadDirectory(path)));
    },

    toggleChecked: (path) =>
      set((state) => {
        const checked = { ...state.checked };
        if (checked[path]) delete checked[path];
        else checked[path] = true;
        return { checked };
      }),

    setChecked: (paths, value) =>
      set((state) => {
        const checked = { ...state.checked };
        for (const path of paths) {
          if (value) checked[path] = true;
          else delete checked[path];
        }
        return { checked };
      }),

    selectInside: async (path, mode) => {
      const state = get();
      const platform = rendererPlatform();
      if (mode === "none") {
        get().setChecked(
          Object.keys(state.checked).filter((key) => isInside(key, path, platform)),
          false,
        );
        return;
      }
      if (!state.expanded[path]) set({ expanded: { ...get().expanded, [path]: true } });
      if (mode === "children") {
        if (get().dirs[path]?.status !== "loaded") await loadDirectory(path);
        get().setChecked(get().dirs[path]?.children ?? [], true);
        return;
      }
      try {
        const paths = await collect(path);
        const entries = get().entries;
        get().setChecked(
          paths.filter((key) => {
            const kind = entries[key]?.kind;
            return mode === "all" || (mode === "files" ? kind === "file" : kind === "directory");
          }),
          true,
        );
      } catch (error) {
        set({ translationError: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
      }
    },

    selectAll: async (mode) => {
      const state = get();
      if (mode === "none") {
        set({ checked: {} });
        return;
      }
      if (mode === "roots") {
        set({ checked: Object.fromEntries(state.roots.map((root) => [root, true as const])) });
        return;
      }
      const directories = state.roots.filter((root) => {
        const entry = state.entries[root];
        return entry?.kind === "directory" && !entry.symlink;
      });
      try {
        await Promise.all(directories.map((root) => collect(root)));
      } catch (error) {
        set({ translationError: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
        return;
      }
      const latest = get();
      const all = new Set<string>(latest.roots);
      const visit = (path: string) => {
        for (const child of latest.dirs[path]?.children ?? []) {
          all.add(child);
          visit(child);
        }
      };
      latest.roots.forEach(visit);
      const checked: Record<string, true> = {};
      for (const path of all) {
        const kind = latest.entries[path]?.kind;
        if (mode === "everything" || (mode === "files" ? kind === "file" : kind === "directory")) checked[path] = true;
      }
      const expanded = { ...latest.expanded };
      directories.forEach((root) => (expanded[root] = true));
      set({ checked, expanded });
    },

    translate: async (scope) => {
      if (get().run) return;
      const model = toRuntimeModel(useModelStore.getState().getTaskProfile());
      if (!model) {
        set({ translationError: { code: "model_auth", message: "missing_task_model" } });
        return;
      }
      const { config, settingsKey } = currentSettings();
      const states = selectRowStates(get());
      const state = get();
      let keys: string[];
      if (Array.isArray(scope)) keys = [...scope];
      else if (scope === "all") {
        keys = Object.keys(state.checked).filter((key) => state.proposals[key]?.edited === undefined);
      } else {
        keys = Object.keys(state.checked).filter((key) => {
          const status = states.get(key)?.status;
          return status === "pending" || status === "stale" || status === "failed";
        });
      }
      keys = keys.filter((key) => state.entries[key]);
      if (keys.length === 0) return;

      const requestId = newRequestId();
      set((current) => {
        const proposals = { ...current.proposals };
        for (const key of keys) {
          const previous = Array.isArray(scope) ? {} : (proposals[key] ?? {});
          proposals[key] = { ...previous, edited: undefined, translating: true, failed: false };
        }
        return { proposals, run: { requestId, total: keys.length, done: 0 }, translationError: null };
      });

      const api = getNameTranslationApi();
      const outcome = await translateTargets({
        targets: keys.map((key) => {
          const entry = state.entries[key]!;
          return { key, name: entry.name, kind: entry.kind, parentPath: entry.parentPath };
        }),
        settings: {
          model,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          instructions: config.instructions,
        },
        requestId,
        translateBatch: (request) => api.translate(request),
        isCancelled: () => get().run?.requestId !== requestId,
        onResult: (key, stem) => {
          if (get().run?.requestId !== requestId) return;
          set((current) => ({
            proposals: {
              ...current.proposals,
              [key]:
                stem === null
                  ? { ...current.proposals[key], translating: false, failed: true }
                  : { stem, settingsKey, translating: false, failed: false },
            },
            run: current.run ? { ...current.run, done: current.run.done + 1 } : current.run,
          }));
        },
      });

      if (get().run?.requestId !== requestId && !outcome.fatal) return;
      set((current) => {
        const proposals = { ...current.proposals };
        for (const key of keys) {
          if (proposals[key]?.translating) proposals[key] = { ...proposals[key], translating: false };
        }
        return {
          proposals,
          run: current.run?.requestId === requestId ? null : current.run,
          translationError: outcome.fatal ?? current.translationError,
        };
      });
    },

    stopTranslation: () => {
      const run = get().run;
      if (!run) return;
      void getNameTranslationApi().cancelTranslate({ requestId: run.requestId }).catch(() => undefined);
      set((state) => {
        const proposals = { ...state.proposals };
        for (const [key, proposal] of Object.entries(proposals)) {
          if (proposal.translating) proposals[key] = { ...proposal, translating: false };
        }
        return { proposals, run: null };
      });
    },

    editName: (path, name) =>
      set((state) => ({
        proposals: { ...state.proposals, [path]: { ...state.proposals[path], edited: name, failed: false } },
        checked: { ...state.checked, [path]: true },
      })),

    resetName: (path) =>
      set((state) => {
        const proposal = state.proposals[path];
        if (!proposal) return {};
        const next = { ...proposal };
        delete (next as { edited?: string }).edited;
        return { proposals: { ...state.proposals, [path]: next } };
      }),

    applyNumbering: () => {
      const state = get();
      const suggestions = suggestNumberedNames(state, selectRowStates(state), rendererPlatform());
      set((current) => {
        const proposals = { ...current.proposals };
        for (const [path, name] of suggestions) {
          proposals[path] = { ...proposals[path], edited: name };
        }
        return { proposals };
      });
    },

    prepareRename: async () => {
      const state = get();
      if (state.preparing || state.applying) return;
      if (getTemplateError(currentSettings().template)) return;
      const states = selectRowStates(state);
      // Only entries that are ready are renamed; untranslated, failed or
      // problematic selections simply keep their names.
      const ready = Object.keys(state.checked).filter((key) => states.get(key)?.status === "ready");
      if (ready.length === 0) return;
      const skipped = { untranslated: 0, issues: 0, unchanged: 0 };
      for (const key of Object.keys(state.checked)) {
        const status = states.get(key)?.status;
        if (status === "issue") skipped.issues += 1;
        else if (status === "unchanged") skipped.unchanged += 1;
        else if (status && status !== "ready" && status !== "idle") skipped.untranslated += 1;
      }
      const items: NameRenameItem[] = ready.map((key) => {
        const entry = state.entries[key]!;
        return { path: entry.path, kind: entry.kind, identity: entry.identity, newName: states.get(key)!.proposedName! };
      });
      set({ preparing: true });
      try {
        const preflight = await unwrap(getNameTranslationApi().preflight({ items }));
        applyServerIssues(items, preflight);
        const accepted = items.filter((_item, index) => preflight.items[index]?.status === "ready");
        if (accepted.length === 0) return;
        set({
          confirm: {
            items: accepted,
            names: Object.fromEntries(accepted.map((item) => [item.path, item.newName])),
            skipped: { ...skipped, issues: skipped.issues + ready.length - accepted.length },
          },
        });
      } catch (error) {
        set({ translationError: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
      } finally {
        set({ preparing: false });
      }
    },

    cancelConfirm: () => {
      if (get().applying) return;
      set({ confirm: null });
    },

    confirmRename: async () => {
      const confirm = get().confirm;
      if (!confirm || get().applying) return;
      set({ applying: true, confirm: { ...confirm, error: undefined } });
      try {
        const result = await unwrap(getNameTranslationApi().apply({ items: confirm.items }));
        if (result.status === "rejected") {
          applyServerIssues(confirm.items, result.preflight);
          set({ confirm: { ...confirm, error: "changed" } });
          return;
        }
        if (result.status === "failed") {
          set({
            confirm: null,
            outcome: {
              kind: "failed",
              message: result.message,
              failedPath: result.failedPath,
              rollback: result.rollback,
              unrecovered: result.unrecovered,
              journalId: result.journalId,
            },
          });
          await get().reloadDirectories();
          return;
        }
        set({ confirm: null, outcome: { kind: "completed", journalId: result.journalId, renamed: result.renamed } });
        await remapAndRebuild(result.renamed, true);
      } catch (error) {
        set({ confirm: { ...confirm, error: error instanceof Error ? error.message : String(error) } });
      } finally {
        set({ applying: false });
      }
    },

    undoLast: async () => {
      const outcome = get().outcome;
      if (!outcome || outcome.kind !== "completed" || outcome.undoState === "running") return;
      set({ outcome: { ...outcome, undoState: "running" } });
      try {
        const result = await unwrap(getNameTranslationApi().undo({ journalId: outcome.journalId }));
        set({
          outcome: {
            ...outcome,
            undoState: result.status === "completed" ? "done" : "partial",
            undoFailures: result.failures,
          },
        });
        await remapAndRebuild(outcome.renamed.map((entry) => ({ from: entry.to, to: entry.from })));
      } catch (error) {
        set({
          outcome: {
            ...outcome,
            undoState: "partial",
            undoFailures: [{ currentPath: "", expectedPath: "", message: error instanceof Error ? error.message : String(error) }],
          },
        });
      }
    },

    dismissOutcome: () => set({ outcome: null }),

    loadRecovery: async () => {
      try {
        const { journals } = await unwrap(getNameTranslationApi().listJournals());
        set({
          recovery: journals.filter(
            (journal) =>
              (journal.status === "running" || journal.status === "failed" || journal.status === "undo_partial") &&
              journal.stepCount > journal.undoneCount,
          ),
        });
      } catch {
        set({ recovery: [] });
      }
    },

    resolveRecovery: async (journalId, action) => {
      if (get().recoveryBusy) return;
      set({ recoveryBusy: journalId });
      try {
        const api = getNameTranslationApi();
        if (action === "dismiss") await unwrap(api.dismissJournal({ journalId }));
        else await unwrap(api.undo({ journalId }));
        await get().loadRecovery();
        const state = get();
        await rebuild(state.roots, Object.keys(state.expanded));
      } catch (error) {
        set({ translationError: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
        await get().loadRecovery();
      } finally {
        set({ recoveryBusy: null });
      }
    },

    loadSession: (session) => {
      get().stopTranslation();
      const entries: Record<string, NameEntry> = {};
      session.entries.forEach((entry) => (entries[entry.path] = entry));
      const dirs: Record<string, DirectoryState> = {};
      const expanded: Record<string, true> = {};
      for (const listing of session.listings) {
        listing.entries.forEach((entry) => (entries[entry.path] = entry));
        dirs[listing.path] = { status: "loaded", children: listing.entries.map((entry) => entry.path), truncated: listing.truncated };
        expanded[listing.path] = true;
      }
      set({
        ...EMPTY_WORKSPACE,
        roots: [...session.roots],
        entries,
        dirs,
        expanded,
        checked: Object.fromEntries(session.checked.map((path) => [path, true as const])),
        proposals: { ...session.proposals },
        filter: "all",
        confirm: null,
        outcome: null,
        rejected: [],
        notice: null,
        translationError: null,
      });
    },
  };

  function applyServerIssues(items: readonly NameRenameItem[], preflight: NamePreflightResult) {
    set((state) => {
      const serverIssues = { ...state.serverIssues };
      items.forEach((item, index) => {
        const result = preflight.items[index];
        if (result?.status === "issue" && result.issue) {
          serverIssues[item.path] = { issue: result.issue, name: item.newName };
        } else {
          delete serverIssues[item.path];
        }
      });
      return { serverIssues };
    });
  }
});

export default useNameTranslatorStore;
