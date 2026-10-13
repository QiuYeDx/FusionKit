import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, RotateCcw } from "lucide-react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ClipPathTabs } from "@/components/qiuye-ui/clip-path-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { buildClientConfig, EXTERNAL_CLIENTS, type ExternalClient, type ExternalTransport } from "@/agent/external/client-configs";
import type { ExternalAgentSettings, ExternalConnectionInfo, ExternalSkillStatus, ExternalSkillTarget, ExternalTrust } from "@/agent/external/contract";
import { useExternalAgentStore } from "@/agent/external/store";

const TRUST_LEVELS: ExternalTrust[] = ["read_only", "confirm_writes", "auto"];

/** Clipboard writes from an unfocused window can fail; a hidden textarea still works there. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = document.createElement("textarea");
    area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
}

/** An icon button that shows a check for a moment after copying. */
function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} data-testid={testId} className="text-muted-foreground hover:text-foreground"
          onClick={() => void copyText(text).then((done) => { if (done) setCopied(true); else toast.error(t("setting:external_agent.copy_failed")); })}>
          {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{copied ? t("setting:external_agent.copied") : label}</TooltipContent>
    </Tooltip>
  );
}

function minutesSince(at: number, now: number) {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

/** Settings → External Agent: access over MCP, its permissions, client setup and live connections. */
export default function ExternalAgentConfig() {
  const { t } = useTranslation();
  const api = typeof window === "undefined" ? undefined : window.externalAgent;
  const status = useExternalAgentStore((state) => state.status);
  const setStatus = useExternalAgentStore((state) => state.setStatus);
  const activity = useExternalAgentStore((state) => state.activity);
  const [settings, setSettings] = useState<ExternalAgentSettings | null>(null);
  const [info, setInfo] = useState<ExternalConnectionInfo | null>(null);
  const [skills, setSkills] = useState<ExternalSkillStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [port, setPort] = useState("");
  const [portError, setPortError] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [client, setClient] = useState<ExternalClient>("claude-code");
  const [transport, setTransport] = useState<ExternalTransport>("http");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!api) return;
    void api.getSettings().then((result) => { if (result.ok) { setSettings(result.value); setPort(String(result.value.port)); } });
    void api.getStatus().then((result) => { if (result.ok) setStatus(result.value); });
    void api.connectionInfo().then((result) => { if (result.ok) setInfo(result.value); });
    void api.skillStatus().then((result) => { if (result.ok) setSkills(result.value); });
  }, [api, setStatus]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const save = useCallback(async (run: () => Promise<{ ok: true; value: ExternalAgentSettings } | { ok: false; error: string }>) => {
    setSaving(true);
    try {
      const result = await run();
      if (result.ok) { setSettings(result.value); setPort(String(result.value.port)); }
      else toast.error(t("setting:external_agent.save_failed"));
      return result.ok;
    } finally { setSaving(false); }
  }, [t]);

  const commitPort = () => {
    if (!api || !settings) return;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) { setPortError(true); return; }
    setPortError(false);
    if (value !== settings.port) void save(() => api.updateSettings({ port: value }));
  };

  if (!api) return null;
  const enabled = settings?.enabled ?? false;
  const token = settings?.token ?? "";
  const running = status?.state === "running";
  const url = status?.url ?? `http://127.0.0.1:${settings?.port ?? ""}/mcp`;
  const config = enabled && token && info ? buildClientConfig(client, transport, { url, token, info }) : null;
  const sessions = status?.sessions ?? [];

  return (
    <Card className="overflow-auto" data-testid="setting-external-agent">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">{t("setting:external_agent.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Access and its state */}
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="setting-external-enable" className="text-sm font-medium">{t("setting:external_agent.enable.label")}</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("setting:external_agent.enable.description")}</p>
            <div className="flex min-w-0 items-center gap-1.5 pt-1 text-xs" data-testid="setting-external-status">
              {running ? <>
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="shrink-0 text-foreground">{t("setting:external_agent.status.running")}</span>
                <span className="min-w-0 truncate font-mono text-muted-foreground">{url}</span>
              </> : status?.state === "error" ? (
                <span className="text-destructive">{t(status.error === "port_in_use" ? "setting:external_agent.status.port_in_use" : "setting:external_agent.status.listen_failed", { port: status.port })}</span>
              ) : <span className="text-muted-foreground">{t("setting:external_agent.status.stopped")}</span>}
            </div>
          </div>
          <Switch id="setting-external-enable" checked={enabled} disabled={!settings || saving} onCheckedChange={(checked) => void save(() => api.updateSettings({ enabled: checked }))} />
        </div>

        {/* Permissions */}
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("setting:external_agent.trust.title")}</div>
          <RadioGroup value={settings?.trust ?? "confirm_writes"} disabled={!settings || saving} className="gap-0 divide-y rounded-lg border"
            onValueChange={(value) => void save(() => api.updateSettings({ trust: value as ExternalTrust }))}>
            {TRUST_LEVELS.map((level) => (
              <label key={level} htmlFor={`setting-external-trust-${level}`} className="flex cursor-pointer items-start justify-between gap-6 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[13px] font-medium">{t(`setting:external_agent.trust.${level}.name`)}</span>
                    {level === "confirm_writes" && <span className="text-[11px] text-muted-foreground">{t("setting:external_agent.trust.recommended")}</span>}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(`setting:external_agent.trust.${level}.description`)}</p>
                </div>
                <RadioGroupItem id={`setting-external-trust-${level}`} value={level} className="mt-0.5" />
              </label>
            ))}
          </RadioGroup>
        </div>

        {/* Port and token */}
        <div className="space-y-3">
          <div className="text-sm font-medium">{t("setting:external_agent.connection.title")}</div>
          <div className="flex items-start gap-3">
            <Label htmlFor="setting-external-port" className="w-12 shrink-0 pt-2 text-[13px] font-normal text-muted-foreground">{t("setting:external_agent.connection.port")}</Label>
            <div className="space-y-1">
              <Input id="setting-external-port" inputMode="numeric" value={port} disabled={!settings || saving} aria-invalid={portError || undefined}
                className="h-8 w-28 font-mono text-[13px]" data-testid="setting-external-port"
                onChange={(event) => { setPort(event.target.value); if (portError) setPortError(false); }}
                onBlur={commitPort} onKeyDown={(event) => { if (event.key === "Enter") commitPort(); }} />
              {portError && <div className="text-[11px] text-destructive" role="alert">{t("setting:external_agent.connection.port_invalid")}</div>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[13px] text-muted-foreground">{t("setting:external_agent.connection.token")}</span>
            {token ? <div className="flex min-w-0 flex-1 items-center gap-1">
              <code className="min-w-0 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-[12px]" data-testid="setting-external-token">
                {showToken ? token : "•".repeat(24)}
              </code>
              <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" data-testid="setting-external-token-toggle"
                aria-label={t(showToken ? "setting:external_agent.connection.hide" : "setting:external_agent.connection.show")} onClick={() => setShowToken((value) => !value)}>
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
              <CopyButton text={token} label={t("setting:external_agent.connection.copy")} testId="setting-external-token-copy" />
              <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" disabled={saving} data-testid="setting-external-token-reset"
                aria-label={t("setting:external_agent.connection.reset")} onClick={() => setResetting(true)}>
                <RotateCcw />
              </Button>
            </div> : <span className="text-xs text-muted-foreground">{t("setting:external_agent.connection.no_token")}</span>}
          </div>
          <ConfirmDialog open={resetting} onOpenChange={setResetting}
            title={t("setting:external_agent.connection.reset_title")} description={t("setting:external_agent.connection.reset_description")}
            confirmText={t("setting:external_agent.connection.reset_confirm")} cancelText={t("setting:external_agent.connection.cancel")}
            onConfirm={() => void save(() => api.regenerateToken())} />
        </div>

        {/* Client setup */}
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("setting:external_agent.clients.title")}</div>
          {config ? <>
            <div className="flex flex-col items-start gap-2">
              <ClipPathTabs value={client} onValueChange={(value) => setClient(value as ExternalClient)} ariaLabel={t("setting:external_agent.clients.title")}
                shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out"
                items={EXTERNAL_CLIENTS.map((value) => ({ value, label: t(`setting:external_agent.clients.${value}`) }))} />
              <ClipPathTabs value={transport} onValueChange={(value) => setTransport(value as ExternalTransport)} ariaLabel={t("setting:external_agent.clients.transport")}
                shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out"
                items={[{ value: "http", label: t("setting:external_agent.clients.http") }, { value: "stdio", label: t("setting:external_agent.clients.stdio") }]} />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(`setting:external_agent.clients.hint.${client}`)}{transport === "stdio" ? ` ${t("setting:external_agent.clients.hint.stdio")}` : ""}
            </p>
            {/* w-0 min-w-full: the settings scroll area sizes like a table, so a long line must not widen the page; it scrolls in the block. */}
            <div className="relative w-0 min-w-full">
              <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted/50 p-3 pr-11 font-mono text-[12px] leading-relaxed" data-testid="setting-external-config">{config.text}</pre>
              <div className="absolute right-1.5 top-1.5 rounded-md border bg-background/90 shadow-xs backdrop-blur-sm">
                <CopyButton text={config.text} label={t("setting:external_agent.clients.copy")} testId="setting-external-config-copy" />
              </div>
            </div>
          </> : <p className="text-xs leading-relaxed text-muted-foreground" data-testid="setting-external-config-disabled">{t("setting:external_agent.clients.disabled")}</p>}
        </div>

        {/* Live connections */}
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("setting:external_agent.sessions.title")}</div>
          {sessions.length ? (
            <div className="divide-y rounded-lg border" data-testid="setting-external-sessions">
              {sessions.map((session) => {
                const last = activity[session.id]?.at(-1);
                const minutes = minutesSince(session.connectedAt, now);
                return (
                  <div key={session.id} className="flex items-center justify-between gap-4 px-3.5 py-2.5" data-testid="setting-external-session">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[13px] font-medium">{session.client.name}</span>
                        {session.client.version && <span className="text-[11px] text-muted-foreground">{session.client.version}</span>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {minutes ? t("setting:external_agent.sessions.connected_minutes", { count: minutes }) : t("setting:external_agent.sessions.connected_now")}
                        {last && <> · {t("setting:external_agent.sessions.last", { tool: last.tool })} <span className={last.ok ? "" : "text-destructive"}>
                          {last.ok ? t("setting:external_agent.sessions.ok") : t("setting:external_agent.sessions.failed", { error: last.error ?? "" })}</span></>}
                      </div>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="shrink-0" data-testid="setting-external-disconnect"
                      onClick={() => void api.closeSession(session.id)}>{t("setting:external_agent.sessions.disconnect")}</Button>
                  </div>
                );
              })}
            </div>
          ) : <p className="text-xs text-muted-foreground" data-testid="setting-external-sessions-empty">{t("setting:external_agent.sessions.empty")}</p>}
        </div>

        {/* Bundled skill */}
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("setting:external_agent.skill.title")}</div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("setting:external_agent.skill.description")}</p>
          <div className="flex flex-wrap gap-2">
            {(["claude", "codex"] as ExternalSkillTarget[]).map((target) => (
              <Button key={target} type="button" variant="outline" size="sm" data-testid={`setting-external-skill-${target}`}
                onClick={() => void api.installSkill(target).then((result) => {
                  if (!result.ok) { toast.error(t("setting:external_agent.skill.install_failed")); return; }
                  setSkills((items) => [...items.filter((item) => item.target !== target), result.value]);
                  toast.success(t("setting:external_agent.skill.install_done"));
                })}>
                {t(target === "claude" ? "setting:external_agent.skill.install_claude" : "setting:external_agent.skill.install_codex")}
              </Button>
            ))}
          </div>
          {skills.filter((item) => item.installed).map((item) => (
            <p key={item.target} className={cn("break-all text-[11px]", item.current ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")} data-testid={`setting-external-skill-status-${item.target}`}>
              {t(item.current ? "setting:external_agent.skill.installed" : "setting:external_agent.skill.outdated", { path: item.path })}
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
