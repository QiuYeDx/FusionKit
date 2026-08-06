import { spawnSync } from "node:child_process";
import path from "node:path";
import { overwriteNativeBackendFailure as failure } from "./overwrite-native-backend-core";

const ELECTRON_HOST_PREFLIGHT_TIMEOUT_MS = 10_000;
const ELECTRON_HOST_PREFLIGHT_SOURCE = [
  '"use strict";',
  "try { require(process.argv[1]); }",
  "catch { process.exit(1); }",
].join("");
const WINDOWS_SYSTEM_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
] as const);

interface LocalSubtitleOverwriteNativeHostPreflightResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface LocalSubtitleOverwriteNativeHostPreflightSpawnOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly shell: false;
  readonly stdio: "ignore";
  readonly timeout: number;
  readonly windowsHide: true;
}

export type LocalSubtitleOverwriteNativeHostPreflightRunner = (
  command: string,
  args: readonly string[],
  options: LocalSubtitleOverwriteNativeHostPreflightSpawnOptions,
) => LocalSubtitleOverwriteNativeHostPreflightResult;

export interface LocalSubtitleOverwriteNativeHostPreflightOptions {
  readonly platform?: NodeJS.Platform | string;
  readonly electronVersion?: string;
  readonly execPath?: string;
  readonly sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly runner?: LocalSubtitleOverwriteNativeHostPreflightRunner;
}

export function preflightLocalSubtitleOverwriteNativeHost(
  absoluteNodePath: string,
  options: LocalSubtitleOverwriteNativeHostPreflightOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const electronVersion = options.electronVersion ?? process.versions.electron;
  if (platform !== "win32" || !electronVersion) return;

  if (
    !path.isAbsolute(absoluteNodePath) ||
    path.extname(absoluteNodePath) !== ".node" ||
    absoluteNodePath.includes("\0")
  ) {
    throw failure(
      "invalid_module_path",
      "A verified absolute .node path is required for the Electron host preflight.",
    );
  }

  const execPath = options.execPath ?? process.execPath;
  const runner = options.runner ?? defaultRunner;
  let result: LocalSubtitleOverwriteNativeHostPreflightResult;
  try {
    result = runner(
      execPath,
      ["-e", ELECTRON_HOST_PREFLIGHT_SOURCE, absoluteNodePath],
      {
        env: buildElectronHostPreflightEnvironment(
          options.sourceEnvironment ?? process.env,
        ),
        shell: false,
        stdio: "ignore",
        timeout: ELECTRON_HOST_PREFLIGHT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (cause) {
    throw failure(
      "module_load_failed",
      "The overwrite native module Electron host preflight could not start.",
      cause,
    );
  }

  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.error !== undefined
  ) {
    throw failure(
      "module_load_failed",
      "The overwrite native module is incompatible with the Electron host.",
      result.error,
    );
  }
}

export function buildElectronHostPreflightEnvironment(
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
  };
  for (const key of WINDOWS_SYSTEM_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (typeof value === "string" && value !== "" && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return Object.freeze(environment);
}

const defaultRunner: LocalSubtitleOverwriteNativeHostPreflightRunner = (
  command,
  args,
  options,
) =>
  spawnSync(command, [...args], {
    ...options,
    // The app augments ProcessEnv with main-process fields, but this child is
    // intentionally given only the small allowlist assembled above.
    env: options.env as NodeJS.ProcessEnv,
  });
