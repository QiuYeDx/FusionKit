import { dialog, ipcMain } from "electron";
import { applyRenamePlan, rollbackRenameJournal } from "./apply";
import { checkRenameTargetPaths } from "./path-check";
import { buildOpenDialogProperties } from "./dialog-options";
import { validateRenamePlan } from "./planner-validation";
import { inspectRenamePaths, scanRenameTargets } from "./scanner";
import type {
  ApplyRenamePlanParams,
  CheckRenameTargetPathsParams,
  CheckRenameTargetPathsResult,
  InspectRenamePathsParams,
  InspectRenamePathsResult,
  NameTranslationApplyResult,
  RollbackRenameJournalParams,
  RollbackRenameJournalResult,
  ScanRenameTargetsParams,
  ScanRenameTargetsResult,
  SelectRenamePathsParams,
  SelectRenamePathsResult,
  ValidateRenamePlanParams,
  ValidateRenamePlanResult,
} from "./types";

export function setupRenameIPC() {
  ipcMain.handle(
    "select-rename-paths",
    async (
      _event,
      params?: SelectRenamePathsParams
    ): Promise<SelectRenamePathsResult> => {
      const result = await dialog.showOpenDialog({
        title: params?.title ?? "Select files or folders",
        buttonLabel: params?.buttonLabel,
        properties: buildOpenDialogProperties(params),
      });

      return {
        canceled: result.canceled,
        filePaths: result.filePaths,
      };
    }
  );

  ipcMain.handle(
    "inspect-rename-paths",
    async (
      _event,
      params: InspectRenamePathsParams
    ): Promise<InspectRenamePathsResult> => inspectRenamePaths(params)
  );

  ipcMain.handle(
    "scan-rename-targets",
    async (
      _event,
      params: ScanRenameTargetsParams
    ): Promise<ScanRenameTargetsResult> => scanRenameTargets(params)
  );

  ipcMain.handle(
    "check-rename-target-paths",
    async (
      _event,
      params: CheckRenameTargetPathsParams
    ): Promise<CheckRenameTargetPathsResult> => checkRenameTargetPaths(params)
  );

  ipcMain.handle(
    "validate-rename-plan",
    async (
      _event,
      params: ValidateRenamePlanParams
    ): Promise<ValidateRenamePlanResult> => validateRenamePlan(params)
  );

  ipcMain.handle(
    "apply-rename-plan",
    async (
      _event,
      params: ApplyRenamePlanParams
    ): Promise<NameTranslationApplyResult> => applyRenamePlan(params)
  );

  ipcMain.handle(
    "rollback-rename-journal",
    async (
      _event,
      params: RollbackRenameJournalParams
    ): Promise<RollbackRenameJournalResult> => rollbackRenameJournal(params)
  );
}
