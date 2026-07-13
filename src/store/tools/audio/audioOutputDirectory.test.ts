import { describe, expect, it } from "vitest";
import {
  isAudioOutputDirectoryAuthorizationValid,
  normalizeAudioOutputDirectoryLabel,
} from "./audioOutputDirectory";

describe("audio output directory authorization", () => {
  it("normalizes persisted POSIX and Windows paths to display labels", () => {
    expect(normalizeAudioOutputDirectoryLabel("/Users/qiuye/Exports/"))
      .toBe("Exports");
    expect(normalizeAudioOutputDirectoryLabel("C:\\Users\\qiuye\\Exports\\"))
      .toBe("Exports");
    expect(normalizeAudioOutputDirectoryLabel("Exports")).toBe("Exports");
  });

  it("requires a matching, unexpired authorization", () => {
    const authorization = {
      outputDirToken: "output_dir_token",
      directoryName: "Exports",
      expiresAt: 2_000,
    };

    expect(
      isAudioOutputDirectoryAuthorizationValid(
        authorization,
        "Exports",
        1_999,
      ),
    ).toBe(true);
    expect(
      isAudioOutputDirectoryAuthorizationValid(
        authorization,
        "Other",
        1_999,
      ),
    ).toBe(false);
    expect(
      isAudioOutputDirectoryAuthorizationValid(
        authorization,
        "Exports",
        2_000,
      ),
    ).toBe(false);
    expect(
      isAudioOutputDirectoryAuthorizationValid(null, "Exports", 1_999),
    ).toBe(false);
  });
});
