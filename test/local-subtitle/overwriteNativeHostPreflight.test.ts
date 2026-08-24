import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildElectronHostPreflightEnvironment,
  preflightLocalSubtitleOverwriteNativeHost,
  type LocalSubtitleOverwriteNativeHostPreflightRunner,
} from "../../electron/main/local-subtitle/overwrite-native-host-preflight";

const absoluteNodePath = path.join(
  path.parse(process.cwd()).root,
  "trusted-runtime",
  "local-subtitle-overwrite.node",
);

describe("local subtitle overwrite Electron host preflight", () => {
  it("runs only for a Windows Electron host", () => {
    const runner = vi.fn<LocalSubtitleOverwriteNativeHostPreflightRunner>();

    preflightLocalSubtitleOverwriteNativeHost(absoluteNodePath, {
      platform: "darwin",
      electronVersion: "33.4.11",
      runner,
    });
    preflightLocalSubtitleOverwriteNativeHost(absoluteNodePath, {
      platform: "win32",
      electronVersion: "",
      runner,
    });

    expect(runner).not.toHaveBeenCalled();
  });

  it("loads the addon in an isolated Electron run-as-Node process", () => {
    const runner = vi.fn<LocalSubtitleOverwriteNativeHostPreflightRunner>(
      () => ({ status: 0, signal: null }),
    );
    const execPath = path.join(path.parse(process.cwd()).root, "Electron.exe");

    preflightLocalSubtitleOverwriteNativeHost(absoluteNodePath, {
      platform: "win32",
      electronVersion: "33.4.11",
      execPath,
      sourceEnvironment: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        NODE_OPTIONS: "--require untrusted.js",
        OPENAI_API_KEY: "secret",
      },
      runner,
    });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      execPath,
      ["-e", expect.stringContaining("require(process.argv[1])"), absoluteNodePath],
      {
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          SystemRoot: "C:\\Windows",
          TEMP: "C:\\Temp",
        },
        shell: false,
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      },
    );
  });

  it.each([
    { status: 1, signal: null },
    { status: null, signal: "SIGTERM" as NodeJS.Signals },
  ])("fails closed when the isolated host does not load the addon: %o", (result) => {
    const runner = vi.fn<LocalSubtitleOverwriteNativeHostPreflightRunner>(
      () => result,
    );

    expect(() =>
      preflightLocalSubtitleOverwriteNativeHost(absoluteNodePath, {
        platform: "win32",
        electronVersion: "33.4.11",
        runner,
      })
    ).toThrowError(expect.objectContaining({ code: "module_load_failed" }));
  });

  it("maps spawn failures without exposing the child environment", () => {
    const cause = new Error("spawn failed");
    const runner = vi.fn<LocalSubtitleOverwriteNativeHostPreflightRunner>(() => {
      throw cause;
    });

    expect(() =>
      preflightLocalSubtitleOverwriteNativeHost(absoluteNodePath, {
        platform: "win32",
        electronVersion: "33.4.11",
        runner,
      })
    ).toThrowError(expect.objectContaining({
      code: "module_load_failed",
      cause,
    }));
  });

  it("builds a minimal environment without app secrets or Node injection", () => {
    const environment = buildElectronHostPreflightEnvironment({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      PATH: "C:\\untrusted",
      NODE_OPTIONS: "--require untrusted.js",
      OPENAI_API_KEY: "secret",
      HTTP_PROXY: "http://secret.invalid",
    });

    expect(environment).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });
});
