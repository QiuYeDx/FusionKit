import type { OpenDialogOptions } from "electron";
import type { SelectRenamePathsParams } from "./types";

export function buildOpenDialogProperties(
  params?: SelectRenamePathsParams,
  platform: NodeJS.Platform = process.platform
): OpenDialogOptions["properties"] {
  const allowFiles = params?.allowFiles ?? true;
  const allowDirectories = params?.allowDirectories ?? true;
  const properties: OpenDialogOptions["properties"] = [];

  if (allowFiles && allowDirectories) {
    if (platform === "darwin") {
      properties.push("openFile", "openDirectory");
    } else {
      // Windows/Linux show a directory picker when both are set, hiding files.
      properties.push("openFile");
    }
  } else {
    if (allowFiles || !allowDirectories) properties.push("openFile");
    if (allowDirectories || !allowFiles) properties.push("openDirectory");
  }

  if (params?.multiSelections ?? true) properties.push("multiSelections");

  return properties;
}
