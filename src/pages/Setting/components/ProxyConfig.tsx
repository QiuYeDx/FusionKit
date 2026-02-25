import { useState, useCallback } from "react";
import useProxyStore, { ProxyMode } from "@/store/useProxyStore";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, CheckCircle2, XCircle, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProxyTestResult {
  success: boolean;
  latencyMs: number;
  ip?: string;
  proxyMode: string;
  proxyAddress?: string;
  httpStatus?: number;
  error?: string;
}

type TestStatus = "idle" | "loading" | "success" | "error";

function ProxyTestButton() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TestStatus>("idle");
  const [result, setResult] = useState<ProxyTestResult | null>(null);

  const runTest = useCallback(async () => {
    setStatus("loading");
    setResult(null);
    try {
      const res: ProxyTestResult = await (window as any).ipcRenderer.invoke(
        "test-proxy-connection"
      );
      setResult(res);
      setStatus(res.success ? "success" : "error");
    } catch {
      setResult({
        success: false,
        latencyMs: 0,
        proxyMode: "unknown",
        error: "IPC call failed",
      });
      setStatus("error");
    }
  }, []);

  const icon = {
    idle: <Wifi className="size-3.5" />,
    loading: <Loader2 className="size-3.5 animate-spin" />,
    success: <CheckCircle2 className="size-3.5" />,
    error: <XCircle className="size-3.5" />,
  }[status];

  const proxyModeLabel = (mode: string) =>
    ({
      none: t("setting:fields.proxy.none"),
      system: t("setting:fields.proxy.system"),
      custom: t("setting:fields.proxy.custom"),
    })[mode] ?? mode;

  const tooltipContent = result ? (
    <div className="space-y-1 text-left text-[11px] max-w-[240px]">
      <div className="flex items-center gap-1.5 font-medium text-xs">
        {result.success ? (
          <CheckCircle2 className="size-3 text-green-400" />
        ) : (
          <XCircle className="size-3 text-red-400" />
        )}
        {result.success
          ? t("setting:fields.proxy.test_success")
          : t("setting:fields.proxy.test_fail")}
      </div>
      <div className="border-t border-white/10 pt-1 space-y-0.5">
        {result.ip && (
          <div>
            <span className="text-white/60">IP: </span>
            {result.ip}
          </div>
        )}
        <div>
          <span className="text-white/60">
            {t("setting:fields.proxy.test_latency")}:{" "}
          </span>
          {result.latencyMs}ms
        </div>
        <div>
          <span className="text-white/60">
            {t("setting:fields.proxy.mode")}:{" "}
          </span>
          {proxyModeLabel(result.proxyMode)}
        </div>
        {result.proxyAddress && (
          <div>
            <span className="text-white/60">
              {t("setting:fields.proxy.test_proxy_addr")}:{" "}
            </span>
            {result.proxyAddress}
          </div>
        )}
        {result.httpStatus && (
          <div>
            <span className="text-white/60">HTTP: </span>
            {result.httpStatus}
          </div>
        )}
        {result.error && (
          <div className="text-red-300 break-all">
            <span className="text-white/60">
              {t("setting:fields.proxy.test_error")}:{" "}
            </span>
            {result.error}
          </div>
        )}
      </div>
    </div>
  ) : (
    <span className="text-[11px]">
      {t("setting:fields.proxy.test_tooltip")}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={runTest}
          disabled={status === "loading"}
          className={cn(
            "inline-flex items-center justify-center rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            status === "success" &&
              "border-green-500/40 text-green-600 dark:text-green-400",
            status === "error" &&
              "border-red-500/40 text-red-600 dark:text-red-400",
            status === "idle" && "border-input",
            status === "loading" && "border-input text-muted-foreground"
          )}
        >
          {icon}
          <span className="ml-1">{t("setting:fields.proxy.test_btn")}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}

function ProxyConfig() {
  const { t } = useTranslation();
  const { proxyConfig, setProxyMode, setProxyHost, setProxyPort } =
    useProxyStore();

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">
          {t("setting:subtitle.proxy_config")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <Label className="text-sm font-medium min-w-[80px]">
            {t("setting:fields.proxy.mode")}
          </Label>
          <ButtonGroup>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.NONE ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.NONE)}
            >
              {t("setting:fields.proxy.none")}
            </Button>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.SYSTEM ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.SYSTEM)}
            >
              {t("setting:fields.proxy.system")}
            </Button>
            <Button
              size="sm"
              variant={
                proxyConfig.mode === ProxyMode.CUSTOM ? "default" : "outline"
              }
              onClick={() => setProxyMode(ProxyMode.CUSTOM)}
            >
              {t("setting:fields.proxy.custom")}
            </Button>
          </ButtonGroup>
          <ProxyTestButton />
        </div>

        {proxyConfig.mode === ProxyMode.CUSTOM && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_120px] gap-4 max-w-2xl">
            <div className="space-y-2">
              <Label htmlFor="proxy-host">
                {t("setting:fields.proxy.host")}
              </Label>
              <Input
                id="proxy-host"
                type="text"
                placeholder={t("setting:placeholder.proxy_host")}
                value={proxyConfig.host}
                onChange={(e) => setProxyHost(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-port">
                {t("setting:fields.proxy.port")}
              </Label>
              <Input
                id="proxy-port"
                type="text"
                inputMode="numeric"
                placeholder={t("setting:placeholder.proxy_port")}
                value={proxyConfig.port}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "");
                  setProxyPort(val);
                }}
                className="w-full"
              />
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground max-w-2xl">
          {proxyConfig.mode === ProxyMode.NONE &&
            t("setting:fields.proxy.none_desc")}
          {proxyConfig.mode === ProxyMode.SYSTEM &&
            t("setting:fields.proxy.system_desc")}
          {proxyConfig.mode === ProxyMode.CUSTOM &&
            t("setting:fields.proxy.custom_desc")}
        </div>
      </CardContent>
    </Card>
  );
}

export default ProxyConfig;
