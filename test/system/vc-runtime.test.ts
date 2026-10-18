import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareVcVersions,
  createRegQuery,
  installedVersionFromRegistry,
  parseRegQueryOutput,
  parseVcVersion,
  MINIMUM_VC_RUNTIME_VERSION,
  readBundledRedist,
  VC_RUNTIME_REGISTRY_KEY,
  VcRuntime,
  vcRuntimeState,
} from "../../electron/main/system/vc-runtime";

// Real `reg.exe query ... /reg:64` output from a Windows 11 machine.
const INSTALLED = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
  "    Version    REG_SZ    v14.53.37000.00",
  "    Installed    REG_DWORD    0x1",
  "    Major    REG_DWORD    0xe",
  "    Minor    REG_DWORD    0x33",
  "    Bld    REG_DWORD    0x8d97",
  "    Rbld    REG_DWORD    0x0",
  "",
].join("\r\n");
const registry = (major: number, minor: number, build: number, installed = 1) => [
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
  `    Installed    REG_DWORD    0x${installed.toString(16)}`,
  `    Major    REG_DWORD    0x${major.toString(16)}`,
  `    Minor    REG_DWORD    0x${minor.toString(16)}`,
  `    Bld    REG_DWORD    0x${build.toString(16)}`,
].join("\r\n");

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function resources(options: { version?: string; minimumVersion?: string; bytes?: Buffer; record?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vc-runtime-"));
  roots.push(root);
  const bytes = options.bytes ?? Buffer.from("fake redistributable");
  await mkdir(path.join(root, "vc-redist"));
  await writeFile(path.join(root, "vc-redist", "vc_redist.x64.exe"), bytes);
  await writeFile(path.join(root, "vc-redist", "vc-redist.json"), JSON.stringify(options.record ?? {
    schemaVersion: 1, fileName: "vc_redist.x64.exe", version: options.version ?? "14.52.36500.0", minimumVersion: options.minimumVersion ?? "14.51.36247",
    sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, signer: "O=Microsoft Corporation",
  }));
  return root;
}

describe("VC++ runtime registry and versions", () => {
  it("parses reg.exe output, including DWORDs in hex", () => {
    const values = parseRegQueryOutput(INSTALLED);
    expect(values.get("Installed")).toBe(1);
    expect(values.get("Major")).toBe(14);
    expect(values.get("Minor")).toBe(51);
    expect(values.get("Bld")).toBe(36247);
    expect(values.get("Version")).toBe("v14.53.37000.00");
    expect(installedVersionFromRegistry(values)).toEqual({ major: 14, minor: 51, build: 36247 });
  });

  it("treats a key without Installed=1 as not installed and falls back to the Version string", () => {
    expect(installedVersionFromRegistry(parseRegQueryOutput(registry(14, 44, 35211, 0)))).toBeUndefined();
    expect(installedVersionFromRegistry(parseRegQueryOutput(""))).toBeUndefined();
    const onlyString = parseRegQueryOutput("    Installed    REG_DWORD    0x1\r\n    Version    REG_SZ    v14.44.35211.00");
    expect(installedVersionFromRegistry(onlyString)).toEqual({ major: 14, minor: 44, build: 35211 });
  });

  it("compares versions part by part", () => {
    const v = (text: string) => parseVcVersion(text)!;
    expect(parseVcVersion("v14.52.36500.00")).toEqual({ major: 14, minor: 52, build: 36500 });
    expect(parseVcVersion("14.52.36500")).toEqual({ major: 14, minor: 52, build: 36500 });
    expect(parseVcVersion("nonsense")).toBeUndefined();
    expect(compareVcVersions(v("14.52.36500"), v("14.52.36500"))).toBe(0);
    expect(compareVcVersions(v("14.44.35210"), v("14.52.36500"))).toBeLessThan(0);
    expect(compareVcVersions(v("14.9.99999"), v("14.10.1"))).toBeLessThan(0);
    expect(compareVcVersions(v("14.53.37000"), v("14.52.36500"))).toBeGreaterThan(0);
    expect(vcRuntimeState(undefined, v("14.52.36500"))).toBe("missing");
    expect(vcRuntimeState(v("14.29.30133"), v("14.52.36500"))).toBe("outdated");
    expect(vcRuntimeState(v("14.52.36500"), v("14.52.36500"))).toBe("ok");
    expect(vcRuntimeState(v("14.53.37000"), v("14.52.36500"))).toBe("ok");
  });

  it.runIf(process.platform === "win32")("reads this computer's registry with reg.exe without failing", async () => {
    const output = await createRegQuery()(VC_RUNTIME_REGISTRY_KEY, 64);
    expect(output === null || typeof output === "string").toBe(true);
    expect(await createRegQuery()("HKLM\\SOFTWARE\\FusionKit-test-key-that-does-not-exist", 64)).toBeNull();
  });
});

describe("VcRuntime", () => {
  it("is not applicable off Windows", async () => {
    const query = vi.fn();
    expect(await new VcRuntime({ platform: "darwin", query, downloadUrl: "https://example.test" }).status()).toEqual({ status: "not_applicable", bundled: false });
    expect(query).not.toHaveBeenCalled();
  });

  it("requires the minimum the programs need, not the bundled build", async () => {
    const root = await resources({ version: "14.52.36500.0" });
    // Older than the bundled redistributable but new enough: fine, so nothing asks for a repair.
    const working = vi.fn(async () => registry(14, 51, 36250));
    expect(await new VcRuntime({ platform: "win32", resourcesPath: root, query: working, downloadUrl: "" }).status())
      .toEqual({ status: "ok", installedVersion: "14.51.36250", requiredVersion: "14.51.36247", bundled: true });
    const old = vi.fn(async () => registry(14, 44, 35211));
    expect(await new VcRuntime({ platform: "win32", resourcesPath: root, query: old, downloadUrl: "" }).status())
      .toEqual({ status: "outdated", installedVersion: "14.44.35211", requiredVersion: "14.51.36247", bundled: true });
    // A packaged build follows its record, which the NSIS defines come from.
    expect((await new VcRuntime({ platform: "win32", resourcesPath: await resources({ minimumVersion: "14.52.36400" }), query: working, downloadUrl: "" }).status()))
      .toMatchObject({ status: "outdated", requiredVersion: "14.52.36400" });
    // Running from source uses the same minimum.
    expect(await new VcRuntime({ platform: "win32", query: old, downloadUrl: "" }).status())
      .toEqual({ status: "outdated", installedVersion: "14.44.35211", requiredVersion: MINIMUM_VC_RUNTIME_VERSION, bundled: false });
  });

  it("keeps the minimum equal to the one the packaging script writes for the installer", async () => {
    // @ts-expect-error The packaging script is plain JavaScript.
    const packaging = await import("../../scripts/packaging/vc-redist.mjs");
    expect(MINIMUM_VC_RUNTIME_VERSION).toBe(packaging.VC_RUNTIME_MINIMUM);
  });

  it("checks the 32-bit view when the 64-bit one has no key, and reports unreadable registries as unknown", async () => {
    const views: number[] = [];
    const query = vi.fn(async (_key: string, view: 64 | 32) => { views.push(view); return view === 32 ? registry(14, 52, 36500) : null; });
    expect((await new VcRuntime({ platform: "win32", query, downloadUrl: "" }).status()).status).toBe("ok");
    expect(views).toEqual([64, 32]);
    expect((await new VcRuntime({ platform: "win32", query: async () => null, downloadUrl: "" }).status()).status).toBe("missing");
    expect((await new VcRuntime({ platform: "win32", query: async () => { throw new Error("denied"); }, downloadUrl: "" }).status()).status).toBe("unknown");
  });

  it("only uses a regular bundled installer inside the resources directory with a valid record", async () => {
    expect(await readBundledRedist(undefined)).toBeUndefined();
    expect(await readBundledRedist("relative/path")).toBeUndefined();
    const good = await resources();
    expect(await readBundledRedist(good)).toMatchObject({ executable: path.join(good, "vc-redist", "vc_redist.x64.exe"), version: { major: 14, minor: 52, build: 36500 } });
    expect(await readBundledRedist(await resources({ record: { schemaVersion: 1, fileName: "other.exe", version: "14.52.36500.0", minimumVersion: "14.51.36247", sha256: "a".repeat(64), byteSize: 1 } }))).toBeUndefined();
    expect(await readBundledRedist(await resources({ record: { schemaVersion: 1, fileName: "vc_redist.x64.exe", version: "12.0.1", minimumVersion: "14.51.36247", sha256: "a".repeat(64), byteSize: 1 } }))).toBeUndefined();
    // The record must name a minimum, and one the bundled build satisfies.
    expect(await readBundledRedist(await resources({ record: { schemaVersion: 1, fileName: "vc_redist.x64.exe", version: "14.52.36500.0", sha256: "a".repeat(64), byteSize: 1 } }))).toBeUndefined();
    expect(await readBundledRedist(await resources({ minimumVersion: "14.53.37000" }))).toBeUndefined();
    if (process.platform !== "win32") {
      const linked = await resources();
      await rm(path.join(linked, "vc-redist", "vc_redist.x64.exe"));
      await symlink(path.join(good, "vc-redist", "vc_redist.x64.exe"), path.join(linked, "vc-redist", "vc_redist.x64.exe"));
      expect(await readBundledRedist(linked)).toBeUndefined();
    }
  });

  it("repairs with the bundled installer and checks again", async () => {
    const root = await resources();
    let installed = false;
    const runInstaller = vi.fn(async () => { installed = true; return 0; });
    const runtime = new VcRuntime({ platform: "win32", resourcesPath: root, downloadUrl: "https://download.test", runInstaller,
      query: async () => (installed ? registry(14, 52, 36500) : null), openExternal: vi.fn() });
    expect((await runtime.status()).status).toBe("missing");
    const result = await runtime.repair();
    expect(runInstaller).toHaveBeenCalledWith(path.join(root, "vc-redist", "vc_redist.x64.exe"), ["/install", "/passive", "/norestart"]);
    expect(result).toEqual({ outcome: "installed", exitCode: 0, status: { status: "ok", installedVersion: "14.52.36500", requiredVersion: "14.51.36247", bundled: true } });
  });

  it("names declined, restart and failed installs, and allows one repair at a time", async () => {
    const root = await resources();
    const outcomes: string[] = [];
    for (const code of [1602, 1223, 3010, 1603]) {
      const runtime = new VcRuntime({ platform: "win32", resourcesPath: root, downloadUrl: "", runInstaller: async () => code,
        query: async () => (code === 3010 ? registry(14, 52, 36500) : null) });
      outcomes.push((await runtime.repair()).outcome);
    }
    expect(outcomes).toEqual(["cancelled", "cancelled", "restart_required", "failed"]);
    // Exit code 0 without the runtime appearing is not a success.
    expect((await new VcRuntime({ platform: "win32", resourcesPath: root, downloadUrl: "", runInstaller: async () => 0, query: async () => null }).repair()).outcome).toBe("failed");
    expect((await new VcRuntime({ platform: "win32", resourcesPath: root, downloadUrl: "", runInstaller: async () => { throw new Error("spawn failed"); }, query: async () => null }).repair()).outcome).toBe("failed");

    let finish!: (code: number) => void;
    const runtime = new VcRuntime({ platform: "win32", resourcesPath: root, downloadUrl: "", query: async () => null,
      runInstaller: () => new Promise((resolve) => { finish = resolve; }) });
    const first = runtime.repair();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await runtime.repair()).outcome).toBe("busy");
    finish(1602);
    expect((await first).outcome).toBe("cancelled");
  });

  it("opens Microsoft's download without a bundled installer, or when its bytes changed", async () => {
    const openExternal = vi.fn(async () => undefined);
    const runInstaller = vi.fn(async () => 0);
    const fromSource = new VcRuntime({ platform: "win32", downloadUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe", openExternal, runInstaller, query: async () => null });
    expect(await fromSource.repair()).toMatchObject({ outcome: "opened_download", status: { status: "missing", bundled: false } });
    const tampered = await resources({ record: { schemaVersion: 1, fileName: "vc_redist.x64.exe", version: "14.52.36500.0", minimumVersion: "14.51.36247", sha256: "b".repeat(64), byteSize: 20 } });
    const changed = new VcRuntime({ platform: "win32", resourcesPath: tampered, downloadUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe", openExternal, runInstaller, query: async () => null });
    expect((await changed.repair()).outcome).toBe("opened_download");
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledWith("https://aka.ms/vs/17/release/vc_redist.x64.exe");
    expect(runInstaller).not.toHaveBeenCalled();
    expect((await new VcRuntime({ platform: "darwin", downloadUrl: "", openExternal, runInstaller }).repair()).outcome).toBe("not_applicable");
  });
});
