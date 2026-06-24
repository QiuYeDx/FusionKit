import { describe, expect, it } from "vitest";
import { buildOpenDialogProperties } from "../../electron/main/rename/dialog-options";

describe("rename dialog options", () => {
  it("uses a file picker for mixed selections on Windows", () => {
    expect(
      buildOpenDialogProperties(
        { allowFiles: true, allowDirectories: true },
        "win32"
      )
    ).toEqual(["openFile", "multiSelections"]);
  });

  it("uses a file picker for mixed selections on Linux", () => {
    expect(
      buildOpenDialogProperties(
        { allowFiles: true, allowDirectories: true },
        "linux"
      )
    ).toEqual(["openFile", "multiSelections"]);
  });

  it("keeps native mixed selection on macOS", () => {
    expect(
      buildOpenDialogProperties(
        { allowFiles: true, allowDirectories: true },
        "darwin"
      )
    ).toEqual(["openFile", "openDirectory", "multiSelections"]);
  });

  it("keeps directory-only selection explicit", () => {
    expect(
      buildOpenDialogProperties(
        { allowFiles: false, allowDirectories: true, multiSelections: false },
        "win32"
      )
    ).toEqual(["openDirectory"]);
  });
});
