import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, Wifi, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/qiuye-ui/segmented-control";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import useNetworkStore from "@/store/useNetworkStore";
import useModelStore from "@/store/useModelStore";
import {
  DOWNLOAD_SOURCE_MODES,
  PROXY_MODES,
  type NetworkErrorCategory,
  type NetworkProxyMode,
  type NetworkSettings,
  type NetworkTestResult,
  type NetworkTestTarget,
} from "@/network/contract";
import { checkCustomProxy, type CustomProxyProblem } from "@/network/proxy-address";
import { networkTestHints } from "./networkTestHints";

const MODE_LABEL_KEYS = {
  none: "setting:fields.proxy.none",
  system: "setting:fields.proxy.system",
  custom: "setting:fields.proxy.custom",
} as const;

const MODE_DESCRIPTION_KEYS = {
  none: "setting:fields.proxy.none_desc",
  system: "setting:fields.proxy.system_desc",
  custom: "setting:fields.proxy.custom_desc",
} as const;

const SOURCE_LABEL_KEYS = {
  auto: "setting:fields.download_source.auto",
  official: "setting:fields.download_source.official",
  mirror: "setting:fields.download_source.mirror",
} as const;

const ERROR_KEYS = {
  dns: "setting:fields.proxy.error.dns",
  timeout: "setting:fields.proxy.error.timeout",
  refused: "setting:fields.proxy.error.refused",
  reset: "setting:fields.proxy.error.reset",
  network_unreachable: "setting:fields.proxy.error.network_unreachable",
  proxy_failed: "setting:fields.proxy.error.proxy_failed",
  proxy_auth: "setting:fields.proxy.error.proxy_auth",
  tls: "setting:fields.proxy.error.tls",
  aborted: "setting:fields.proxy.error.aborted",
  unknown: "setting:fields.proxy.error.unknown",
} as const satisfies Record<NetworkErrorCategory, string>;

const TARGET_LABEL_KEYS = {
  model_api: "setting:fields.proxy.test_target_model_api",
  github: "setting:fields.proxy.test_target_github",
  official: "setting:fields.proxy.test_target_download_official",
  mirror: "setting:fields.proxy.test_target_download_mirror",
} as const;

/** Why a custom proxy is not used yet; the main process then connects directly. */
const PROXY_PROBLEM_KEYS = {
  incomplete: "setting:fields.proxy.custom_incomplete",
  credentials: "setting:fields.proxy.custom_credentials",
  invalid: "setting:fields.proxy.custom_invalid",
} as const satisfies Record<CustomProxyProblem, string>;

/** Test results belong to the settings they were made with. */
function settingsKey(settings: NetworkSettings): string {
  return JSON.stringify([settings.proxy.mode, settings.proxy.host, settings.proxy.port, settings.downloadSource]);
}

function targetLabelKey(target: NetworkTestTarget) {
  if (target.kind === "model_api") return TARGET_LABEL_KEYS.model_api;
  if (target.kind === "github") return TARGET_LABEL_KEYS.github;
  return target.source === "mirror" ? TARGET_LABEL_KEYS.mirror : TARGET_LABEL_KEYS.official;
}

function NetworkTestResults({ result }: { result: NetworkTestResult }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl space-y-2" data-testid="network-test-results">
      <ul className="divide-y rounded-smooth-lg border text-xs">
        {result.targets.map((target, index) => (
          <li key={`${target.kind}-${target.host}-${index}`} className="flex items-start gap-2.5 px-3 py-2">
            {target.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-green-600 dark:text-green-400" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{t(targetLabelKey(target), { host: target.host })}</div>
              <div className="mt-0.5 text-muted-foreground">
                {target.via
                  ? t("setting:fields.proxy.test_via_proxy", { proxy: target.via })
                  : t("setting:fields.proxy.test_via_direct")}
              </div>
            </div>
            <div className={target.ok ? "shrink-0 text-muted-foreground" : "shrink-0 text-right text-red-600 dark:text-red-400"}>
              {target.ok
                ? t("setting:fields.proxy.test_latency_value", { ms: target.latencyMs })
                : t(ERROR_KEYS[target.category ?? "unknown"])}
            </div>
          </li>
        ))}
      </ul>
      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground" data-testid="network-test-hints">
        {networkTestHints(result).map((hint) => <p key={hint}>{t(hint)}</p>)}
      </div>
    </div>
  );
}

function ProxyConfig() {
  const { t } = useTranslation();
  const { settings, setProxyMode, setProxyHost, setProxyPort, setDownloadSource, flush, saveFailed } = useNetworkStore();
  const profiles = useModelStore((state) => state.profiles);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ readonly key: string; readonly result: NetworkTestResult | null } | null>(null);
  const { proxy } = settings;
  const currentKey = settingsKey(settings);
  // A result made with other settings would look like the new ones failed; it is simply not shown.
  const current = tested?.key === currentKey ? tested : null;
  const proxyCheck = proxy.mode === "custom" ? checkCustomProxy(proxy.host, proxy.port) : undefined;

  const runTest = useCallback(async () => {
    setTesting(true);
    // An address still waiting for the typing pause is sent first, so main tests what is on screen.
    await flush();
    const key = settingsKey(useNetworkStore.getState().settings);
    try {
      // Only the service addresses are sent for the test; keys stay in this window.
      const modelEndpoints = profiles.map((profile) => profile.baseUrl).filter((url) => url.trim());
      setTested({ key, result: (await window.network?.test({ modelEndpoints })) ?? null });
    } catch {
      setTested({ key, result: null });
    } finally {
      setTesting(false);
    }
  }, [flush, profiles]);

  return (
    <>
      <Card className="overflow-auto">
        <CardHeader className="sticky left-0">
          <CardTitle className="text-xl">{t("setting:subtitle.proxy_config")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4">
            <Label className="text-sm font-medium min-w-[80px]">{t("setting:fields.proxy.mode")}</Label>
            <SegmentedControl
              size="sm"
              fullWidth
              className="min-w-0 flex-1"
              value={proxy.mode}
              aria-label={t("setting:fields.proxy.mode")}
              items={PROXY_MODES.map((mode) => ({ value: mode, label: t(MODE_LABEL_KEYS[mode]) }))}
              onValueChange={(mode) => setProxyMode(mode as NetworkProxyMode)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={testing} data-testid="network-test-button">
              {testing ? <Loader2 className="animate-spin" /> : <Wifi />}
              {t("setting:fields.proxy.test_btn")}
            </Button>
          </div>

          {proxy.mode === "custom" && (
            <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-4 max-w-2xl">
              <div className="space-y-2">
                <Label htmlFor="proxy-host">{t("setting:fields.proxy.host")}</Label>
                <Input
                  id="proxy-host"
                  type="text"
                  placeholder={t("setting:placeholder.proxy_host")}
                  value={proxy.host}
                  onChange={(event) => setProxyHost(event.target.value)}
                  className="w-full"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy-port">{t("setting:fields.proxy.port")}</Label>
                <Input
                  id="proxy-port"
                  type="text"
                  inputMode="numeric"
                  placeholder={t("setting:placeholder.proxy_port")}
                  value={proxy.port}
                  onChange={(event) => setProxyPort(event.target.value)}
                  className="w-full"
                />
              </div>
            </div>
          )}

          <div className="text-xs leading-relaxed text-muted-foreground max-w-2xl">
            {t(MODE_DESCRIPTION_KEYS[proxy.mode])}
            {proxyCheck && !proxyCheck.ok && (
              <span role="status" className="block mt-1 text-amber-600 dark:text-amber-400">{t(PROXY_PROBLEM_KEYS[proxyCheck.problem])}</span>
            )}
          </div>

          {saveFailed && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t("setting:fields.proxy.save_failed")}</p>
          )}
          {current && !current.result && !testing && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t("setting:fields.proxy.test_failed")}</p>
          )}
          {current?.result && !testing && <NetworkTestResults result={current.result} />}
          {testing && <p className="text-xs text-muted-foreground">{t("setting:fields.proxy.test_running")}</p>}
        </CardContent>
      </Card>

      <Card className="overflow-auto">
        <CardHeader className="sticky left-0">
          <CardTitle className="text-xl">{t("setting:subtitle.download_source")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
            <Label className="text-sm font-medium min-w-[80px]">{t("setting:fields.download_source.label")}</Label>
            <SegmentedControl
              size="sm"
              fullWidth
              className="min-w-0 flex-1"
              value={settings.downloadSource}
              aria-label={t("setting:fields.download_source.label")}
              items={DOWNLOAD_SOURCE_MODES.map((source) => ({ value: source, label: t(SOURCE_LABEL_KEYS[source]) }))}
              onValueChange={(source) => setDownloadSource(source as (typeof DOWNLOAD_SOURCE_MODES)[number])}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground max-w-2xl">
            {t("setting:fields.download_source.description")}
          </p>
        </CardContent>
      </Card>
    </>
  );
}

export default ProxyConfig;
