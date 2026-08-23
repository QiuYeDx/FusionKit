import {
  getLocalSubtitleRuntimeService,
} from "@/services/local-subtitle/localSubtitleRuntimeService";
import {
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleConflictPolicy,
  type LocalSubtitleFormat,
  type LocalSubtitleTaskMode,
  type SubtitleTranslationHandoffMode,
} from "@/type/localSubtitle";
import type {
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleOutputDirectorySelection,
} from "@/type/localSubtitleIpc";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_DRAFT_PREFERENCES,
  DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
  sanitizeLocalSubtitleTranscriberDraftPreferences,
  sanitizeLocalSubtitleTranscriberPreferences,
  type LocalSubtitleTranscriberDraftPreferences,
  type LocalSubtitleTranscriberPreferences,
} from "./localSubtitleTranscriberConfig";

export const LOCAL_SUBTITLE_TRANSCRIBER_STORE_VERSION = 3;

type ActiveOutputDirectory = Extract<
  LocalSubtitleOutputDirectorySelection,
  { cancelled: false }
>;

export interface LocalSubtitleTranscriberStore {
  readonly preferences: LocalSubtitleTranscriberPreferences;
  readonly draftInputFiles: readonly LocalSubtitleAuthorizedMedia[];
  readonly draftOutputDirectory: ActiveOutputDirectory | null;
  readonly draftInitialPrompt: string;
  readonly draftTaskMode: LocalSubtitleTaskMode;
  readonly draftConflictPolicy: LocalSubtitleConflictPolicy;
  readonly draftPostActionMode: SubtitleTranslationHandoffMode;
  readonly draftPreferredHandoffFormat: LocalSubtitleFormat;

  updatePreferences(
    patch: Partial<LocalSubtitleTranscriberPreferences>,
  ): void;
  setDraftInputFiles(files: readonly LocalSubtitleAuthorizedMedia[]): void;
  addDraftInputFiles(files: readonly LocalSubtitleAuthorizedMedia[]): void;
  removeDraftInputFile(fileToken: string): void;
  setDraftOutputDirectory(output: ActiveOutputDirectory | null): void;
  setDraftInitialPrompt(prompt: string): void;
  setDraftTaskMode(mode: LocalSubtitleTaskMode): void;
  setDraftConflictPolicy(policy: LocalSubtitleConflictPolicy): void;
  setDraftPostActionMode(mode: SubtitleTranslationHandoffMode): void;
  setDraftPreferredHandoffFormat(format: LocalSubtitleFormat): void;
  resetDraft(): void;
  consumeDraftCapabilitiesAfterCommit(fileTokens: readonly string[]): void;
}

const useLocalSubtitleTranscriberStore = create<LocalSubtitleTranscriberStore>()(
  persist(
    (set, get) => ({
      preferences: sanitizeLocalSubtitleTranscriberPreferences(
        DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_PREFERENCES,
      ),
      ...createEmptyDraftState(),

      updatePreferences: (patch) => {
        const current = get();
        const preferences = sanitizeLocalSubtitleTranscriberPreferences({
          ...current.preferences,
          ...patch,
        });
        if (
          preferences.outputMode === "source" &&
          current.draftOutputDirectory
        ) {
          getLocalSubtitleRuntimeService().queueOutputDraftRevocation(
            current.draftOutputDirectory,
          );
        }
        set({
          preferences,
          ...(preferences.outputMode === "source"
            ? { draftOutputDirectory: null }
            : {}),
        });
      },
      setDraftInputFiles: (files) => {
        const { accepted: nextFiles, rejected } = partitionAuthorizedMedia(
          files,
          LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
        );
        const nextTokens = new Set(nextFiles.map((file) => file.fileToken));
        const cleanupByToken = new Map<string, LocalSubtitleAuthorizedMedia>();
        for (const dropped of rejected) {
          if (!nextTokens.has(dropped.fileToken)) {
            cleanupByToken.set(dropped.fileToken, dropped);
          }
        }
        for (const current of get().draftInputFiles) {
          if (!nextTokens.has(current.fileToken)) {
            cleanupByToken.set(current.fileToken, current);
          }
        }
        const runtime = getLocalSubtitleRuntimeService();
        for (const cleanup of cleanupByToken.values()) {
          runtime.queueInputDraftRevocation(cleanup);
        }
        set({ draftInputFiles: nextFiles });
      },
      addDraftInputFiles: (files) => {
        const currentFiles = get().draftInputFiles;
        const { accepted: nextFiles, rejected } = partitionAuthorizedMedia(
          [...currentFiles, ...files],
          LOCAL_SUBTITLE_LIMITS.maxBatchFiles,
        );
        const runtime = getLocalSubtitleRuntimeService();
        const nextTokens = new Set(nextFiles.map((file) => file.fileToken));
        for (const dropped of rejected) {
          if (!nextTokens.has(dropped.fileToken)) {
            runtime.queueInputDraftRevocation(dropped);
          }
        }
        set({ draftInputFiles: nextFiles });
      },
      removeDraftInputFile: (fileToken) => {
        const current = get().draftInputFiles.find(
          (file) => file.fileToken === fileToken,
        );
        if (!current) return;
        getLocalSubtitleRuntimeService().queueInputDraftRevocation(current);
        set((state) => ({
          draftInputFiles: state.draftInputFiles.filter(
            (file) => file.fileToken !== fileToken,
          ),
        }));
      },
      setDraftOutputDirectory: (output) => {
        const current = get().draftOutputDirectory;
        if (current && current.outputDirToken !== output?.outputDirToken) {
          getLocalSubtitleRuntimeService().queueOutputDraftRevocation(current);
        }
        set((state) => ({
          draftOutputDirectory: output,
          ...(output
            ? {
                preferences: sanitizeLocalSubtitleTranscriberPreferences({
                  ...state.preferences,
                  outputMode: "custom",
                  outputDirectoryDisplayLabel: output.displayLabel,
                }),
              }
            : {}),
        }));
      },
      setDraftInitialPrompt: (draftInitialPrompt) =>
        set({
          draftInitialPrompt: draftInitialPrompt.slice(
            0,
            LOCAL_SUBTITLE_LIMITS.maxInitialPromptChars,
          ),
        }),
      setDraftTaskMode: (draftTaskMode) => set({ draftTaskMode }),
      setDraftConflictPolicy: (draftConflictPolicy) =>
        set({ draftConflictPolicy }),
      setDraftPostActionMode: (draftPostActionMode) =>
        set({ draftPostActionMode }),
      setDraftPreferredHandoffFormat: (draftPreferredHandoffFormat) =>
        set({ draftPreferredHandoffFormat }),
      resetDraft: () => {
        const current = get();
        const runtime = getLocalSubtitleRuntimeService();
        for (const file of current.draftInputFiles) {
          runtime.queueInputDraftRevocation(file);
        }
        if (current.draftOutputDirectory) {
          runtime.queueOutputDraftRevocation(current.draftOutputDirectory);
        }
        set(createEmptyDraftState());
      },
      consumeDraftCapabilitiesAfterCommit: (fileTokens) => {
        const committedTokens = new Set(fileTokens);
        set((state) => ({
          draftInputFiles: state.draftInputFiles.filter(
            (file) => !committedTokens.has(file.fileToken),
          ),
          draftOutputDirectory: null,
        }));
      },
    }),
    {
      name: "fusionkit-local-subtitle-transcriber",
      storage: createJSONStorage(() => localStorage),
      version: LOCAL_SUBTITLE_TRANSCRIBER_STORE_VERSION,
      partialize: (state) => ({
        preferences: sanitizeLocalSubtitleTranscriberPreferences(
          state.preferences,
        ),
        draftPreferences: sanitizeLocalSubtitleTranscriberDraftPreferences({
          initialPrompt: state.draftInitialPrompt,
          taskMode: state.draftTaskMode,
          conflictPolicy: state.draftConflictPolicy,
          postActionMode: state.draftPostActionMode,
          preferredHandoffFormat: state.draftPreferredHandoffFormat,
        }),
      }),
      migrate: (persisted, version) =>
        migrateLocalSubtitleTranscriberPersistedState(persisted, version),
      merge: (persisted, current) => {
        const saved = isRecord(persisted) ? persisted : {};
        const draftPreferences = readPersistedDraftPreferences(saved);
        return {
          ...current,
          preferences: sanitizeLocalSubtitleTranscriberPreferences(
            saved.preferences,
          ),
          draftInputFiles: [],
          draftOutputDirectory: null,
          ...draftPreferencesToState(draftPreferences),
        };
      },
    },
  ),
);

export function migrateLocalSubtitleTranscriberPersistedState(
  persisted: unknown,
  _version: number,
): Record<string, unknown> {
  const saved = isRecord(persisted) ? persisted : {};
  return {
    preferences: sanitizeLocalSubtitleTranscriberPreferences(saved.preferences),
    draftPreferences: readPersistedDraftPreferences(saved),
  };
}

function createEmptyDraftState() {
  return {
    draftInputFiles: [] as readonly LocalSubtitleAuthorizedMedia[],
    draftOutputDirectory: null as ActiveOutputDirectory | null,
    ...draftPreferencesToState(
      DEFAULT_LOCAL_SUBTITLE_TRANSCRIBER_DRAFT_PREFERENCES,
    ),
  };
}

function readPersistedDraftPreferences(
  saved: Record<string, unknown>,
): LocalSubtitleTranscriberDraftPreferences {
  const legacyDraftPreferences = {
    initialPrompt: saved.draftInitialPrompt,
    taskMode: saved.draftTaskMode,
    conflictPolicy: saved.draftConflictPolicy,
    postActionMode: saved.draftPostActionMode,
    preferredHandoffFormat: saved.draftPreferredHandoffFormat,
  };
  return sanitizeLocalSubtitleTranscriberDraftPreferences(
    saved.draftPreferences ?? legacyDraftPreferences,
  );
}

function draftPreferencesToState(
  preferences: LocalSubtitleTranscriberDraftPreferences,
) {
  return {
    draftInitialPrompt: preferences.initialPrompt,
    draftTaskMode: preferences.taskMode,
    draftConflictPolicy: preferences.conflictPolicy,
    draftPostActionMode: preferences.postActionMode,
    draftPreferredHandoffFormat: preferences.preferredHandoffFormat,
  };
}

function partitionAuthorizedMedia(
  files: readonly LocalSubtitleAuthorizedMedia[],
  limit: number,
): {
  readonly accepted: LocalSubtitleAuthorizedMedia[];
  readonly rejected: LocalSubtitleAuthorizedMedia[];
} {
  const tokens = new Set<string>();
  const sourceKeys = new Set<string>();
  const accepted: LocalSubtitleAuthorizedMedia[] = [];
  const rejected: LocalSubtitleAuthorizedMedia[] = [];
  for (const file of files) {
    if (
      accepted.length >= limit ||
      tokens.has(file.fileToken) ||
      sourceKeys.has(file.sourceKey)
    ) {
      rejected.push(file);
      continue;
    }
    tokens.add(file.fileToken);
    sourceKeys.add(file.sourceKey);
    accepted.push(file);
  }
  return { accepted, rejected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default useLocalSubtitleTranscriberStore;
