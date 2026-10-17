import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Eye, EyeOff, FilePen, FolderOpen, RotateCcw } from "lucide-react";
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
import { buildClientConfig, clientTransports, connectionFields, EXTERNAL_CLIENTS, isWritableClient, type ExternalClient, type ExternalTransport } from "@/agent/external/client-configs";
import type { ExternalAgentSettings, ExternalClientConfigStatus, ExternalClientConfigWrite, ExternalConnectionInfo, ExternalSkillStatus, ExternalSkillTarget, ExternalTrust } from "@/agent/external/contract";
import { useExternalAgentStore } from "@/agent/external/store";
import { setActivityNotices } from "@/agent/external/activity-store";
import { toolLabel } from "@/agent/external/activity-text";
import { externalActivityPath } from "@/pages/ExternalAgentActivity/route";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ExternalAgentPermissions } from "./ExternalAgentPermissions";

const TRUST_LEVELS: ExternalTrust[] = ["read_only", "confirm_writes", "auto", "full", "custom"];

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
  const [chosenTransport, setTransport] = useState<ExternalTransport>("http");
  const [clientFiles, setClientFiles] = useState<ExternalClientConfigStatus[]>([]);
  const [written, setWritten] = useState<ExternalClientConfigWrite | null>(null);
  const [writeError, setWriteError] = useState<{ client: string; path?: string; code: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmFull, setConfirmFull] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!api) return;
    void api.getSettings().then((result) => { if (result.ok) { setSettings(result.value); setPort(String(result.value.port)); } });
    void api.getStatus().then((result) => { if (result.ok) setStatus(result.value); });
    void api.connectionInfo().then((result) => { if (result.ok) setInfo(result.value); });
    void api.skillStatus().then((result) => { if (result.ok) setSkills(result.value); });
    void api.clientConfigStatus().then((result) => { if (result.ok) setClientFiles(result.value); });
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
  // Claude Desktop only starts local commands; other clients choose.
  const transports = clientTransports(client);
  const transport = transports.includes(chosenTransport) ? chosenTransport : transports[0];
  const input = enabled && token && info ? { url, token, info } : null;
  const config = input ? buildClientConfig(client, transport, input) : null;
  const clientFile = isWritableClient(client) ? clientFiles.find((item) => item.client === client) : undefined;
  const writeClientFile = async () => {
    if (!isWritableClient(client)) return;
    setWriteError(null); setWritten(null);
    const result = await api.writeClientConfig({ client, transport });
    if (result.ok) {
      setWritten(result.value);
      toast.success(t("setting:external_agent.clients.write_done"));
      const status = await api.clientConfigStatus();
      if (status.ok) setClientFiles(status.value);
    } else setWriteError({ client, path: clientFile?.path, code: result.error });
  };
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
          <RadioGroup value={settings?.trust ?? "confirm_writes"} disabled={!settings || saving} className="gap-0 divide-y rounded-smooth-lg border"
            onValueChange={(value) => {
              // Full access asks once, here, instead of in every call.
              if (value === "full") setConfirmFull(true);
              else void save(() => api.updateSettings({ trust: value as ExternalTrust }));
            }}>
            {TRUST_LEVELS.map((level) => (
              <label key={level} htmlFor={`setting-external-trust-${level}`} className="flex cursor-pointer items-start justify-between gap-6 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[13px] font-medium">{t(`setting:external_agent.trust.${level}.name`)}</span>
                    {level === "confirm_writes" && <span className="text-[11px] text-muted-foreground">{t("setting:external_agent.trust.recommended")}</span>}
                    {level === "full" && <span className="text-[11px] text-amber-600 dark:text-amber-400">{t("setting:external_agent.trust.full.badge")}</span>}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(`setting:external_agent.trust.${level}.description`)}</p>
                </div>
                <RadioGroupItem id={`setting-external-trust-${level}`} value={level} className="mt-0.5" />
              </label>
            ))}
          </RadioGroup>
          <AnimatePresence initial={false}>
            {settings?.trust === "custom" && (
              <motion.div key="permissions" className="!mt-0 overflow-hidden"
                initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.32, bounce: 0 }}>
                {/* The gap lives inside, so it opens and closes with the panel. */}
                <div className="pt-2">
                  <ExternalAgentPermissions permissions={settings.permissions} disabled={saving}
                    onChange={(change) => void save(() => api.updateSettings({ permissions: change }))} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <ConfirmDialog open={confirmFull} onOpenChange={setConfirmFull}
            title={t("setting:external_agent.trust.full.confirm_title")} description={t("setting:external_agent.trust.full.confirm_body")}
            confirmText={t("setting:external_agent.trust.full.confirm_action")}
            onConfirm={() => { setConfirmFull(false); void save(() => api.updateSettings({ trust: "full" })); }} />
          <label htmlFor="setting-external-notices" className="flex cursor-pointer items-start justify-between gap-6 rounded-smooth-lg border px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t("setting:external_agent.activity.settings.notices_title")}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("setting:external_agent.activity.settings.notices_description")}</p>
            </div>
            <Switch id="setting-external-notices" checked={settings?.notices ?? true} disabled={!settings || saving} data-testid="setting-external-notices"
              onCheckedChange={(checked) => void save(() => api.updateSettings({ notices: checked })).then((saved) => { if (saved) setActivityNotices(checked); })} />
          </label>
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
              <code className="min-w-0 truncate rounded-smooth-md border bg-muted/40 px-2 py-1 font-mono text-[12px]" data-testid="setting-external-token">
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
            <div className="flex w-full flex-col items-start gap-2">
              <ClipPathTabs value={client} onValueChange={(value) => { setClient(value as ExternalClient); setWritten(null); setWriteError(null); }} ariaLabel={t("setting:external_agent.clients.title")}
                shape="rounded" smoothCorners size="sm" fullWidth transitionDuration={200} transitionEasing="ease-out"
                items={EXTERNAL_CLIENTS.map((value) => ({ value, label: t(`setting:external_agent.clients.${value}`) }))} />
              {transports.length > 1 ? (
                <ClipPathTabs value={transport} onValueChange={(value) => setTransport(value as ExternalTransport)} ariaLabel={t("setting:external_agent.clients.transport")}
                  shape="rounded" smoothCorners size="sm" transitionDuration={200} transitionEasing="ease-out"
                  items={[{ value: "http", label: t("setting:external_agent.clients.http") }, { value: "stdio", label: t("setting:external_agent.clients.stdio") }]} />
              ) : <span className="text-[11px] text-muted-foreground">{t("setting:external_agent.clients.stdio_only")}</span>}
            </div>
            <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/70" data-testid="setting-external-guide">
              <li>{t(`setting:external_agent.clients.guide.${client}.step1`)}</li>
              <li>{t(`setting:external_agent.clients.guide.${client}.step2`)}</li>
              <li>{t(`setting:external_agent.clients.guide.${client}.step3`)}</li>
              {transport === "stdio" && <li>{t("setting:external_agent.clients.guide.stdio")}</li>}
            </ol>
            {/* w-0 min-w-full: the settings scroll area sizes like a table, so a long line must not widen the page; it scrolls in the block. */}
            <div className="relative w-0 min-w-full">
              <pre className="overflow-x-auto whitespace-pre rounded-smooth-md border bg-muted/50 p-3 pr-11 font-mono text-[12px] leading-relaxed" data-testid="setting-external-config">{config.text}</pre>
              <div className="absolute right-1.5 top-1.5 rounded-smooth-md border bg-background/90 shadow-xs backdrop-blur-sm">
                <CopyButton text={config.text} label={t("setting:external_agent.clients.copy")} testId="setting-external-config-copy" />
              </div>
            </div>
            {isWritableClient(client) && <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2">
                {client === "cursor" && <Button type="button" size="sm" data-testid="setting-external-cursor-install"
                  onClick={() => void api.openClientInstall({ client: "cursor", transport }).then((result) => { if (!result.ok) toast.error(t("setting:external_agent.clients.install_failed")); })}>
                  <ExternalLink />{t("setting:external_agent.clients.install_cursor")}
                </Button>}
                <Button type="button" variant="outline" size="sm" data-testid="setting-external-write-config" onClick={() => void writeClientFile()}>
                  <FilePen />{t("setting:external_agent.clients.write")}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" data-testid="setting-external-reveal-config"
                  onClick={() => void api.revealClientConfig(client).then((result) => { if (!result.ok) toast.error(t("setting:external_agent.clients.reveal_failed")); })}>
                  <FolderOpen />{t("setting:external_agent.clients.reveal")}
                </Button>
              </div>
              <div className="space-y-0.5 break-all text-[11px]" data-testid="setting-external-config-file">
                {writeError?.client === client ? <p className="text-destructive" role="alert">
                  {t(writeError.code === "config_unreadable" ? "setting:external_agent.clients.config_unreadable" : "setting:external_agent.clients.write_failed", { path: writeError.path ?? "" })}
                </p> : written?.client === client ? <>
                  <p className="text-emerald-600 dark:text-emerald-400">{t("setting:external_agent.clients.written", { path: written.path })}</p>
                  {written.backupPath && <p className="text-muted-foreground">{t("setting:external_agent.clients.backup", { path: written.backupPath })}</p>}
                </> : clientFile && <p className="text-muted-foreground">
                  {t(clientFile.configured ? "setting:external_agent.clients.configured" : "setting:external_agent.clients.file", { path: clientFile.path })}
                </p>}
              </div>
            </div>}
            {client === "json" && input && (
              <div className="w-0 min-w-full divide-y rounded-smooth-lg border" data-testid="setting-external-fields">
                {connectionFields(transport, input).map((field) => (
                  <div key={field.key} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="w-16 shrink-0 text-[12px] text-muted-foreground">{t(`setting:external_agent.clients.field.${field.key as "url" | "header" | "command" | "args" | "env"}`)}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={field.value}>{field.value}</code>
                    <CopyButton text={field.value} label={t("setting:external_agent.clients.copy_field")} />
                  </div>
                ))}
              </div>
            )}
          </> : <p className="text-xs leading-relaxed text-muted-foreground" data-testid="setting-external-config-disabled">{t("setting:external_agent.clients.disabled")}</p>}
        </div>

        {/* Live connections */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">{t("setting:external_agent.sessions.title")}</div>
            <Button asChild variant="link" size="sm" className="h-auto px-0 text-xs" data-testid="setting-external-activity">
              <Link to={externalActivityPath()}>{t("setting:external_agent.activity.settings.view_all")}</Link>
            </Button>
          </div>
          {sessions.length ? (
            <div className="divide-y rounded-smooth-lg border" data-testid="setting-external-sessions">
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
                        {last && <> · {t("setting:external_agent.sessions.last", { tool: toolLabel(t, last.tool) })} <span className={last.ok ? "" : "text-destructive"}>
                          {last.ok ? t("setting:external_agent.sessions.ok") : t("setting:external_agent.sessions.failed", { error: last.error ?? "" })}</span></>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button asChild variant="ghost" size="sm" data-testid="setting-external-session-activity">
                        <Link to={externalActivityPath(session.id)}>{t("setting:external_agent.activity.settings.view_session")}</Link>
                      </Button>
                      <Button type="button" variant="outline" size="sm" data-testid="setting-external-disconnect"
                        onClick={() => void api.closeSession(session.id)}>{t("setting:external_agent.sessions.disconnect")}</Button>
                    </div>
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
            {(["claude", "agents"] as ExternalSkillTarget[]).map((target) => (
              <Button key={target} type="button" variant="outline" size="sm" data-testid={`setting-external-skill-${target}`}
                onClick={() => void api.installSkill(target).then((result) => {
                  if (!result.ok) { toast.error(t("setting:external_agent.skill.install_failed")); return; }
                  setSkills((items) => [...items.filter((item) => item.target !== target), result.value]);
                  toast.success(t("setting:external_agent.skill.install_done"));
                })}>
                {t(target === "claude" ? "setting:external_agent.skill.install_claude" : "setting:external_agent.skill.install_agents")}
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
