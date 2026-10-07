import { useCallback, useEffect, useMemo, useRef, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import ToolPageHeader from "@/pages/Tools/_shared/ToolPageHeader";
import { TOOL_META } from "@/pages/Tools/_shared/toolMeta";
import { ToolDetailLayout } from "@/pages/Tools/_shared/ui";
import { useToolFileDropTarget } from "@/pages/Tools/_shared/ui/ToolFileDropScope";
import { getFilePathFromFile } from "@/utils/filePath";
import { showToast } from "@/utils/toast";
import useModelStore from "@/store/useModelStore";
import useNameTranslatorConfigStore, { resolveNameTemplate } from "@/store/tools/rename/nameTranslatorConfig";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import { getNameTranslationApi, rendererPlatform, toRuntimeModel, unwrap } from "@/services/name-translation/api";
import { toWorkspaceSession } from "@/services/name-translation/agentPlan";
import {
  computeRowStates,
  computeVisibleRows,
  settingsKeyOf,
} from "@/services/name-translation/workspace";
import { getTemplateError } from "@/name-translation/naming-rules";
import { NameTranslatorBanners } from "./components/Banners";
import { ConfirmRenameDialog } from "./components/ConfirmRenameDialog";
import { EntryList, summarize } from "./components/EntryList";
import { AddEntriesPanel, SettingsPanel } from "./components/SidePanels";

export default function NameTranslator() {
  const { t } = useTranslation("rename");
  const [searchParams, setSearchParams] = useSearchParams();
  const config = useNameTranslatorConfigStore((state) => state.config);
  const taskProfile = useModelStore((state) => state.getTaskProfile());
  const modelReady = Boolean(toRuntimeModel(taskProfile));

  const roots = useNameTranslatorStore((state) => state.roots);
  const entries = useNameTranslatorStore((state) => state.entries);
  const dirs = useNameTranslatorStore((state) => state.dirs);
  const checked = useNameTranslatorStore((state) => state.checked);
  const proposals = useNameTranslatorStore((state) => state.proposals);
  const serverIssues = useNameTranslatorStore((state) => state.serverIssues);
  const expanded = useNameTranslatorStore((state) => state.expanded);
  const filter = useNameTranslatorStore((state) => state.filter);
  const adding = useNameTranslatorStore((state) => state.adding);
  const rejected = useNameTranslatorStore((state) => state.rejected);
  const applying = useNameTranslatorStore((state) => state.applying);
  const run = useNameTranslatorStore((state) => state.run);

  const data = useMemo(
    () => ({ roots, entries, dirs, checked, proposals, serverIssues }),
    [roots, entries, dirs, checked, proposals, serverIssues],
  );
  const settings = useMemo(
    () => ({ template: resolveNameTemplate(config), settingsKey: settingsKeyOf(config), platform: rendererPlatform() }),
    [config],
  );
  const states = useMemo(() => computeRowStates(data, settings), [data, settings]);
  const rows = useMemo(() => computeVisibleRows(data, expanded, states, filter), [data, expanded, states, filter]);
  const summary = useMemo(() => summarize(checked, states), [checked, states]);

  const addFromDialog = useCallback(
    async (kind: "file" | "directory") => {
      try {
        const result = await unwrap(
          getNameTranslationApi().selectPaths({
            kind,
            title: kind === "file" ? t("add.files") : t("add.folders"),
          }),
        );
        if (!result.canceled && result.paths.length > 0) {
          await useNameTranslatorStore.getState().addPaths(result.paths, "picker");
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
    },
    [t],
  );

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    // Capture native paths synchronously inside the drop event (FK-PIT-0148).
    const paths = Array.from(event.dataTransfer.files)
      .map(getFilePathFromFile)
      .filter((path): path is string => Boolean(path));
    if (paths.length > 0) void useNameTranslatorStore.getState().addPaths(paths, "drop");
  };
  const { dragging, dropProps } = useToolFileDropTarget({
    onDrop: handleDrop,
    label: t("add.drop_label"),
    disabled: applying || adding,
  });

  // Recovery prompt for interrupted runs.
  useEffect(() => {
    void useNameTranslatorStore.getState().loadRecovery();
  }, []);

  // Changing the hidden-item setting reloads what is already listed.
  const includeHiddenRef = useRef(config.includeHidden);
  useEffect(() => {
    if (includeHiddenRef.current === config.includeHidden) return;
    includeHiddenRef.current = config.includeHidden;
    void useNameTranslatorStore.getState().reloadDirectories();
  }, [config.includeHidden]);

  // HomeAgent handoff: ?planId= loads a reviewed plan into the workspace.
  const requestedPlanId = searchParams.get("planId")?.trim() ?? "";
  useEffect(() => {
    if (!requestedPlanId) return;
    const session = toWorkspaceSession(requestedPlanId);
    if (session) {
      useNameTranslatorConfigStore.getState().updateConfig(session.settings);
      useNameTranslatorStore.getState().loadSession(session);
      showToast(t("agent.loaded"), "success");
    } else {
      showToast(t("agent.missing"), "error");
    }
    const next = new URLSearchParams(searchParams);
    next.delete("planId");
    setSearchParams(next, { replace: true });
  }, [requestedPlanId, searchParams, setSearchParams, t]);

  const header = (
    <ToolPageHeader meta={TOOL_META.nameTranslator} title={t("page.title")} description={t("page.description")} />
  );

  const aside = (
    <div className="flex flex-col gap-4">
      <AddEntriesPanel
        adding={adding}
        dragging={dragging}
        rejected={rejected}
        onAddFiles={() => void addFromDialog("file")}
        onAddFolders={() => void addFromDialog("directory")}
      />
      <SettingsPanel disabled={Boolean(run) || applying} />
    </div>
  );

  return (
    <>
      <ToolDetailLayout header={header} aside={aside} asideClassName="order-2 lg:order-1" mainClassName="order-1 lg:order-2">
        <NameTranslatorBanners modelReady={modelReady} />
        <div {...dropProps} className="min-w-0">
          <EntryList
            rows={rows}
            states={states}
            summary={summary}
            modelReady={modelReady}
            formatInvalid={config.nameMode === "custom" && Boolean(getTemplateError(config.customTemplate))}
            onAddFiles={() => void addFromDialog("file")}
            onAddFolders={() => void addFromDialog("directory")}
          />
        </div>
      </ToolDetailLayout>
      <ConfirmRenameDialog />
    </>
  );
}
