import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { VcRuntimeRepairResult, VcRuntimeStatus } from "@/system-setup/contract";

/**
 * Microsoft's VC++ v14 x64 runtime, which the Windows transcription server needs. The
 * installer reads the same registry key and installs the bundled redistributable when it is
 * missing or older than the minimum below (build/installer.nsh); this module lets the application
 * check again and repair.
 */
export const VC_RUNTIME_REGISTRY_KEY = "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64";
/**
 * The oldest runtime the transcription programs can use: they are linked by the MSVC 14.51
 * toolset, and Microsoft requires a runtime at least as new as the toolset. A packaged build reads the
 * same value from its vc-redist.json (VC_RUNTIME_MINIMUM in scripts/packaging/vc-redist.mjs), so the
 * installer and the application agree. A runtime older than the bundled one but not than this works,
 * and is left alone.
 */
export const MINIMUM_VC_RUNTIME_VERSION = "14.51.36247";
export const VC_REDIST_DIRECTORY = "vc-redist";
export const VC_REDIST_FILE = "vc_redist.x64.exe";
export const VC_REDIST_RECORD = "vc-redist.json";
/** Exit codes that mean the runtime is in place: done, a newer one was there, done but restart. */
const INSTALLED_EXIT_CODES = new Set([0, 1638]);
const RESTART_EXIT_CODE = 3010;
/** The user declined Windows' confirmation (Burn reports 1602; ShellExecute's ERROR_CANCELLED is 1223). */
const CANCELLED_EXIT_CODES = new Set([1602, 1223]);
const REPAIR_TIMEOUT_MS = 15 * 60_000;

export interface VcRuntimeVersion { readonly major: number; readonly minor: number; readonly build: number }

export function parseVcVersion(value: string | undefined): VcRuntimeVersion | undefined {
  const match = /^\s*v?(\d{1,3})\.(\d{1,3})\.(\d{1,6})(?:\.\d+)?\s*$/u.exec(value ?? "");
  return match ? { major: Number(match[1]), minor: Number(match[2]), build: Number(match[3]) } : undefined;
}

export function formatVcVersion(version: VcRuntimeVersion): string {
  return `${version.major}.${version.minor}.${version.build}`;
}

export function compareVcVersions(left: VcRuntimeVersion, right: VcRuntimeVersion): number {
  return left.major - right.major || left.minor - right.minor || left.build - right.build;
}

/** Values of one `reg.exe query` key: name → raw value (REG_DWORD as a number). */
export function parseRegQueryOutput(output: string): Map<string, string | number> {
  const values = new Map<string, string | number>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*?)\s*$/u.exec(line);
    if (!match) continue;
    const [, name, type, raw] = match;
    values.set(name!, type === "REG_DWORD" || type === "REG_QWORD" ? Number.parseInt(raw!, 16) : raw!);
  }
  return values;
}

/** The installed runtime from the registry values, or undefined when it is not installed. */
export function installedVersionFromRegistry(values: Map<string, string | number>): VcRuntimeVersion | undefined {
  if (values.get("Installed") !== 1) return undefined;
  const [major, minor, build] = ["Major", "Minor", "Bld"].map((name) => values.get(name));
  if ([major, minor, build].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return { major: major as number, minor: minor as number, build: build as number };
  }
  const version = values.get("Version");
  return typeof version === "string" ? parseVcVersion(version) : undefined;
}

export function vcRuntimeState(installed: VcRuntimeVersion | undefined, required: VcRuntimeVersion): VcRuntimeStatus["status"] {
  if (!installed) return "missing";
  return compareVcVersions(installed, required) < 0 ? "outdated" : "ok";
}

export type RegQuery = (key: string, view: 64 | 32) => Promise<string | null>;

/** `reg.exe query` in one registry view; null when the key does not exist. */
export function createRegQuery(env: NodeJS.ProcessEnv = process.env): RegQuery {
  const reg = path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "reg.exe");
  return (key, view) => new Promise((resolve, reject) => {
    execFile(reg, ["query", key, `/reg:${view}`], { windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (!error) { resolve(String(stdout)); return; }
      // Exit code 1 is "the key does not exist"; anything else could not be read.
      if ((error as { code?: unknown }).code === 1) resolve(null);
      else reject(error);
    });
  });
}

export interface BundledRedist {
  readonly executable: string;
  readonly version: VcRuntimeVersion;
  /** The oldest runtime this build's programs can use. */
  readonly minimumVersion: VcRuntimeVersion;
  readonly sha256: string;
  readonly byteSize: number;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The redistributable shipped in resources/vc-redist and its version record, or undefined when
 * this build has none (running from source). Only paths inside the resources directory count.
 */
export async function readBundledRedist(resourcesPath: string | undefined): Promise<BundledRedist | undefined> {
  if (!resourcesPath || !path.isAbsolute(resourcesPath)) return undefined;
  const directory = path.join(resourcesPath, VC_REDIST_DIRECTORY);
  const executable = path.join(directory, VC_REDIST_FILE);
  const recordPath = path.join(directory, VC_REDIST_RECORD);
  if (!inside(resourcesPath, executable) || !inside(resourcesPath, recordPath)) return undefined;
  try {
    for (const file of [executable, recordPath]) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    }
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const version = typeof record.version === "string" ? parseVcVersion(record.version) : undefined;
    const minimumVersion = typeof record.minimumVersion === "string" ? parseVcVersion(record.minimumVersion) : undefined;
    if (record.schemaVersion !== 1 || record.fileName !== VC_REDIST_FILE || version?.major !== 14
      || minimumVersion?.major !== 14 || compareVcVersions(minimumVersion, version) > 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || typeof record.byteSize !== "number" || !Number.isSafeInteger(record.byteSize)) return undefined;
    return { executable, version, minimumVersion, sha256: record.sha256, byteSize: record.byteSize };
  } catch {
    return undefined;
  }
}

/** The bundled installer still has the bytes its record names. */
export async function verifyBundledRedist(redist: BundledRedist): Promise<boolean> {
  try {
    const bytes = await readFile(redist.executable);
    return bytes.length === redist.byteSize && createHash("sha256").update(bytes).digest("hex") === redist.sha256;
  } catch {
    return false;
  }
}

export interface VcRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly resourcesPath?: string;
  readonly query?: RegQuery;
  /** Starts the installer and resolves with its exit code. */
  readonly runInstaller?: (executable: string, args: readonly string[]) => Promise<number>;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly downloadUrl: string;
}

export function runInstallerProcess(executable: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // The Burn bundle elevates itself; /passive shows its progress after Windows' confirmation.
    const child = spawn(executable, [...args], { windowsHide: false, stdio: "ignore", shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error("The VC++ installer did not finish in time.")); }, REPAIR_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
}

export class VcRuntime {
  readonly #options: VcRuntimeOptions;
  #repair?: Promise<VcRuntimeRepairResult>;

  constructor(options: VcRuntimeOptions) {
    this.#options = options;
  }

  async status(): Promise<VcRuntimeStatus> {
    const platform = this.#options.platform ?? process.platform;
    const bundled = await readBundledRedist(this.#options.resourcesPath);
    if (platform !== "win32") return { status: "not_applicable", bundled: !!bundled };
    // Only a runtime the programs cannot use needs the repair, not one older than the bundled build.
    const required = bundled?.minimumVersion ?? parseVcVersion(MINIMUM_VC_RUNTIME_VERSION)!;
    const query = this.#options.query ?? createRegQuery();
    let installed: VcRuntimeVersion | undefined;
    try {
      // A 64-bit process sees the native view; the redistributable has also been seen under WOW6432Node.
      for (const view of [64, 32] as const) {
        const output = await query(VC_RUNTIME_REGISTRY_KEY, view);
        installed = output === null ? undefined : installedVersionFromRegistry(parseRegQueryOutput(output));
        if (installed) break;
      }
    } catch {
      return { status: "unknown", requiredVersion: formatVcVersion(required), bundled: !!bundled };
    }
    return {
      status: vcRuntimeState(installed, required),
      ...(installed ? { installedVersion: formatVcVersion(installed) } : {}),
      requiredVersion: formatVcVersion(required),
      bundled: !!bundled,
    };
  }

  /** One repair at a time; a second request while one runs reports "busy". */
  repair(): Promise<VcRuntimeRepairResult> {
    if (this.#repair) return this.status().then((status) => ({ outcome: "busy" as const, status }));
    this.#repair = this.#runRepair().finally(() => { this.#repair = undefined; });
    return this.#repair;
  }

  async #runRepair(): Promise<VcRuntimeRepairResult> {
    const before = await this.status();
    if (before.status === "not_applicable") return { outcome: "not_applicable", status: before };
    const bundled = await readBundledRedist(this.#options.resourcesPath);
    if (!bundled || !(await verifyBundledRedist(bundled))) {
      // Without an intact bundled installer (running from source), Microsoft's download opens instead.
      await (this.#options.openExternal ?? (async () => undefined))(this.#options.downloadUrl);
      return { outcome: "opened_download", status: before };
    }
    let exitCode: number;
    try {
      exitCode = await (this.#options.runInstaller ?? runInstallerProcess)(bundled.executable, ["/install", "/passive", "/norestart"]);
    } catch {
      return { outcome: "failed", status: await this.status() };
    }
    const status = await this.status();
    const outcome = exitCode === RESTART_EXIT_CODE ? "restart_required"
      : CANCELLED_EXIT_CODES.has(exitCode) ? "cancelled"
        : INSTALLED_EXIT_CODES.has(exitCode) && status.status === "ok" ? "installed" : "failed";
    return { outcome, exitCode, status };
  }
}
