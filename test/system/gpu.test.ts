import { describe, expect, it, vi } from "vitest";
import { detectGpu, nvidiaDriverAtLeast, nvidiaVersionFromWindowsDriver, parseNvidiaSmi, parseVideoControllers } from "../../electron/main/system/gpu";

const env = { SystemRoot: "C:\\Windows", ProgramW6432: "C:\\Program Files" };

describe("NVIDIA detection", () => {
  it("parses nvidia-smi CSV output", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4070 Ti SUPER, 610.88\r\n")).toEqual({ gpuName: "NVIDIA GeForce RTX 4070 Ti SUPER", driverVersion: "610.88" });
    // A name with a comma keeps everything before the last one; the first card wins.
    expect(parseNvidiaSmi("Quadro RTX 4000, Max-Q, 551.61\nNVIDIA T4, 552.22\n")).toEqual({ gpuName: "Quadro RTX 4000, Max-Q", driverVersion: "551.61" });
    expect(parseNvidiaSmi("NVIDIA GeForce GTX 1060, [N/A]")).toEqual({ gpuName: "NVIDIA GeForce GTX 1060" });
    expect(parseNvidiaSmi("")).toBeUndefined();
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toBeUndefined();
  });

  it("compares driver versions with the CUDA 12.4 minimum", () => {
    expect(nvidiaDriverAtLeast("551.61")).toBe(true);
    expect(nvidiaDriverAtLeast("551.78")).toBe(true);
    expect(nvidiaDriverAtLeast("610.88")).toBe(true);
    expect(nvidiaDriverAtLeast("551.52")).toBe(false);
    expect(nvidiaDriverAtLeast("531.79")).toBe(false);
    expect(nvidiaDriverAtLeast(undefined)).toBe(false);
    expect(nvidiaDriverAtLeast("unknown")).toBe(false);
  });

  it("reads NVIDIA's version from the Windows driver version", () => {
    expect(nvidiaVersionFromWindowsDriver("31.0.15.5161")).toBe("551.61");
    expect(nvidiaVersionFromWindowsDriver("32.0.15.6110")).toBe("561.10");
    expect(nvidiaVersionFromWindowsDriver("27.21.14.6109")).toBe("461.09");
    expect(nvidiaVersionFromWindowsDriver("")).toBeUndefined();
    expect(nvidiaVersionFromWindowsDriver("31.0.101")).toBeUndefined();
    expect(parseVideoControllers("Intel(R) UHD Graphics 770|31.0.101.4502\r\nNVIDIA GeForce RTX 3060|31.0.15.5161\r\n"))
      .toEqual({ gpuName: "NVIDIA GeForce RTX 3060", driverVersion: "551.61" });
    expect(parseVideoControllers("AMD Radeon RX 7800 XT|31.0.24027.1012\r\nMeta Virtual Monitor|\r\n")).toBeUndefined();
  });

  it("asks nvidia-smi first, then Windows, within the command timeout", async () => {
    const run = vi.fn(async (file: string) => {
      if (file === "C:\\Windows\\System32\\nvidia-smi.exe") return "NVIDIA GeForce RTX 4060, 560.94\n";
      throw new Error("not reached");
    });
    expect(await detectGpu({ platform: "win32", env, run })).toEqual({ status: "detected", hasNvidia: true, gpuName: "NVIDIA GeForce RTX 4060",
      driverVersion: "560.94", driverOk: true, source: "nvidia-smi" });
    expect(run).toHaveBeenCalledWith("C:\\Windows\\System32\\nvidia-smi.exe", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);

    const calls: string[] = [];
    const fallback = vi.fn(async (file: string) => {
      calls.push(file);
      if (file.endsWith("powershell.exe")) return "NVIDIA GeForce GTX 1660|27.21.14.5179\r\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(await detectGpu({ platform: "win32", env, run: fallback })).toEqual({ status: "detected", hasNvidia: true, gpuName: "NVIDIA GeForce GTX 1660",
      driverVersion: "451.79", driverOk: false, source: "windows" });
    expect(calls).toEqual(["C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  });

  it("reports no NVIDIA card, unknown, and not applicable", async () => {
    const none = async (file: string) => { if (file.endsWith("powershell.exe")) return "Intel(R) Iris(R) Xe Graphics|31.0.101.5186\r\n"; throw new Error("missing"); };
    expect(await detectGpu({ platform: "win32", env, run: none })).toEqual({ status: "detected", hasNvidia: false, driverOk: false, source: "windows" });
    expect(await detectGpu({ platform: "win32", env, run: async () => { throw new Error("blocked"); } })).toEqual({ status: "unknown", hasNvidia: false, driverOk: false });
    const run = vi.fn();
    expect(await detectGpu({ platform: "darwin", env, run })).toEqual({ status: "not_applicable", hasNvidia: false, driverOk: false });
    expect(run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("detects this computer's graphics card without failing", async () => {
    const result = await detectGpu();
    expect(["detected", "unknown"]).toContain(result.status);
    if (result.hasNvidia) expect(result.gpuName).toMatch(/\S/);
  }, 20_000);
});
