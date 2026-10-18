import { describe, expect, it } from "vitest";
import type { NetworkErrorCategory, NetworkTestResult, NetworkTestTarget } from "@/network/contract";
import { NETWORK_TEST_HINT_KEYS as KEYS, networkTestHints } from "./networkTestHints";

const ok = (kind: NetworkTestTarget["kind"], source?: "official" | "mirror"): NetworkTestTarget => ({
  kind, host: "h", ...(source ? { source } : {}), ok: true, latencyMs: 10, via: null,
});
const failed = (kind: NetworkTestTarget["kind"], category: NetworkErrorCategory, source?: "official" | "mirror"): NetworkTestTarget => ({
  kind, host: "h", ...(source ? { source } : {}), ok: false, latencyMs: 10, category, via: null,
});
const result = (targets: NetworkTestTarget[], overrides: Partial<NetworkTestResult> = {}): NetworkTestResult => ({
  proxyMode: "system", downloadSource: "auto", targets, ...overrides,
});

describe("network test hints", () => {
  it("says everything works in one line", () => {
    expect(networkTestHints(result([ok("model_api"), ok("model_download", "official"), ok("model_download", "mirror"), ok("github")]))).toEqual([KEYS.ok]);
  });

  it("reassures a mainland user without a proxy: AI and downloads work, updates use the mirrors", () => {
    const hints = networkTestHints(result([
      ok("model_api"), failed("model_download", "timeout", "official"), ok("model_download", "mirror"), failed("github", "timeout"),
    ]));
    expect(hints).toEqual([KEYS.ai_ok, KEYS.download_mirror, KEYS.github_failed]);
    expect(networkTestHints(result([ok("model_api"), ok("model_download", "mirror"), failed("github", "timeout")], { downloadSource: "mirror" })))
      .toEqual([KEYS.ai_ok, KEYS.download_ok, KEYS.github_failed]);
  });

  it("says update checks fail when only GitHub itself is used, and how to fix it", () => {
    expect(networkTestHints(result([ok("model_download", "official"), failed("github", "dns")], { downloadSource: "official" })))
      .toEqual([KEYS.download_ok, KEYS.github_failed_official]);
  });

  it("suggests the automatic source when only the official address is tested and fails", () => {
    expect(networkTestHints(result([failed("model_download", "dns", "official"), ok("github")], { downloadSource: "official" })))
      .toEqual([KEYS.download_switch]);
    expect(networkTestHints(result([failed("model_download", "dns", "official"), failed("model_download", "reset", "mirror"), ok("github")])))
      .toEqual([KEYS.download_failed]);
  });

  it("points to the model address when the model service fails, and to the system proxy in no-proxy mode", () => {
    expect(networkTestHints(result([failed("model_api", "dns"), ok("model_download", "mirror"), ok("github")], { proxyMode: "none", downloadSource: "mirror" })))
      .toEqual([KEYS.ai_failed, KEYS.download_ok, KEYS.try_system]);
  });

  it("names the proxy as the only cause, by mode, and a proxy that wants a password", () => {
    const viaProxy = [failed("model_api", "proxy_failed"), failed("github", "proxy_failed")];
    expect(networkTestHints(result(viaProxy, { proxyMode: "custom" }))).toEqual([KEYS.proxy_custom]);
    expect(networkTestHints(result(viaProxy))).toEqual([KEYS.proxy_system]);
    expect(networkTestHints(result([failed("github", "proxy_auth"), failed("model_api", "proxy_failed")]))).toEqual([KEYS.proxy_auth]);
  });
});
