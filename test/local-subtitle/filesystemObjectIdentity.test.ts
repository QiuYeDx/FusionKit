import { lstatSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  localSubtitleFilesystemObjectIdentityForPathSync,
  localSubtitleWindowsObjectIdentityFromStats,
  sameLocalSubtitleFilesystemObjectIdentity,
  snapshotLocalSubtitleFilesystemObjectIdentity,
} from "../../electron/main/local-subtitle/filesystem-object-identity";

describe("local subtitle filesystem object identity", () => {
  it("encodes exact Windows bigint identity components at fixed widths", () => {
    expect(localSubtitleWindowsObjectIdentityFromStats({
      dev: 0x680b91a8n,
      ino: 0x2800000013944fn,
    })).toEqual({
      volumeSerialHex: "680b91a8",
      fileIdHex: "0000000000000000002800000013944f",
    });
  });

  it("rejects negative or over-width Windows identity components", () => {
    expect(() =>
      localSubtitleWindowsObjectIdentityFromStats({
        dev: -1n,
        ino: 1n,
      })
    ).toThrow(TypeError);
    expect(() =>
      localSubtitleWindowsObjectIdentityFromStats({
        dev: 0x1_0000_0000n,
        ino: 1n,
      })
    ).toThrow(TypeError);
    expect(() =>
      localSubtitleWindowsObjectIdentityFromStats({
        dev: 1n,
        ino: 1n << 128n,
      })
    ).toThrow(TypeError);
  });

  it("keeps identity arms exact and rejects malformed Windows strings", () => {
    const windows = Object.freeze({
      volumeSerialHex: "680b91a8",
      fileIdHex: "0000000000000000002800000013944f",
    });
    const posix = Object.freeze({ dev: 1, ino: 2, birthtimeMs: 3 });

    expect(snapshotLocalSubtitleFilesystemObjectIdentity(windows)).toEqual(
      windows,
    );
    expect(snapshotLocalSubtitleFilesystemObjectIdentity({
      ...windows,
      fileIdHex: windows.fileIdHex.toUpperCase(),
    })).toBeUndefined();
    expect(sameLocalSubtitleFilesystemObjectIdentity(windows, posix)).toBe(
      false,
    );
  });

  it("captures the host filesystem using the platform identity arm", () => {
    const identity =
      localSubtitleFilesystemObjectIdentityForPathSync(process.cwd());

    if (process.platform === "win32") {
      const exact = lstatSync(process.cwd(), { bigint: true });
      expect(identity).toEqual({
        volumeSerialHex: exact.dev.toString(16).padStart(8, "0"),
        fileIdHex: exact.ino.toString(16).padStart(32, "0"),
      });
    } else {
      expect(identity).toMatchObject({
        dev: expect.any(Number),
        ino: expect.any(Number),
        birthtimeMs: expect.any(Number),
      });
    }
  });
});
