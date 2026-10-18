import type { NetworkTestResult } from "@/network/contract";

export const NETWORK_TEST_HINT_KEYS = {
  ok: "setting:fields.proxy.test_hint_ok",
  proxy_custom: "setting:fields.proxy.test_hint_proxy",
  proxy_system: "setting:fields.proxy.test_hint_proxy_system",
  proxy_auth: "setting:fields.proxy.test_hint_proxy_auth",
  ai_ok: "setting:fields.proxy.test_hint_ai_ok",
  ai_failed: "setting:fields.proxy.test_hint_ai_failed",
  download_ok: "setting:fields.proxy.test_hint_download_ok",
  download_mirror: "setting:fields.proxy.test_hint_download_mirror",
  download_switch: "setting:fields.proxy.test_hint_download_switch",
  download_failed: "setting:fields.proxy.test_hint_download_failed",
  github_failed: "setting:fields.proxy.test_hint_github_failed",
  github_failed_official: "setting:fields.proxy.test_hint_github_failed_official",
  try_system: "setting:fields.proxy.test_hint_try_system",
} as const;

export type NetworkTestHintKey = (typeof NETWORK_TEST_HINT_KEYS)[keyof typeof NETWORK_TEST_HINT_KEYS];

/**
 * What the test result means for each thing the app does, one line each: AI calls (the model
 * services), model downloads (any working source is enough) and updates (GitHub, which the
 * "auto" and "mirror first" sources replace with the mirrors). A proxy that cannot be used
 * explains every failure, so it is the only line then.
 */
export function networkTestHints(result: NetworkTestResult): readonly NetworkTestHintKey[] {
  const keys = NETWORK_TEST_HINT_KEYS;
  const failed = result.targets.filter((target) => !target.ok);
  if (!failed.length) return [keys.ok];
  if (failed.some((target) => target.category === "proxy_auth")) return [keys.proxy_auth];
  if (failed.some((target) => target.category === "proxy_failed")) {
    return [result.proxyMode === "custom" ? keys.proxy_custom : keys.proxy_system];
  }
  const hints: NetworkTestHintKey[] = [];
  const services = result.targets.filter((target) => target.kind === "model_api");
  if (services.length) hints.push(services.every((target) => target.ok) ? keys.ai_ok : keys.ai_failed);
  const downloads = result.targets.filter((target) => target.kind === "model_download");
  if (downloads.length) {
    const official = downloads.find((target) => target.source === "official");
    if (downloads.some((target) => target.ok)) hints.push(official && !official.ok ? keys.download_mirror : keys.download_ok);
    else hints.push(result.downloadSource === "official" ? keys.download_switch : keys.download_failed);
  }
  if (result.targets.some((target) => target.kind === "github" && !target.ok)) {
    hints.push(result.downloadSource === "official" ? keys.github_failed_official : keys.github_failed);
  }
  if (result.proxyMode === "none") hints.push(keys.try_system);
  return hints;
}
