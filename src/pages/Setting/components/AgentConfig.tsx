import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import useAgentStore from "@/store/agent/useAgentStore";
import { clearAllSessions } from "@/agent/session-persistence";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import useWebLookupStore, { BILIGAME_WIKI_LIMIT, parseBiligameWikis } from "@/store/useWebLookupStore";
import { WEB_SOURCES, type WebSource } from "@/web-lookup/contract";

const SOURCE_SITES: Record<WebSource, string> = {
  wikipedia: "zh / ja / en.wikipedia.org",
  moegirl: "moegirl.uk",
  baidu_baike: "baike.baidu.com",
  biligame: "wiki.biligame.com",
  bing: "cn.bing.com",
};

function BiligameWikis({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const saved = useWebLookupStore((state) => state.biligameWikis);
  const setBiligameWikis = useWebLookupStore((state) => state.setBiligameWikis);
  const [text, setText] = useState(saved.join(", "));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(saved.join(", ")), [saved]);

  const commit = () => {
    const { codes, invalid } = parseBiligameWikis(text);
    if (invalid.length) return setError(t("setting:agent.biligame.invalid", { codes: invalid.join(", ") }));
    if (codes.length > BILIGAME_WIKI_LIMIT) return setError(t("setting:agent.biligame.too_many", { count: BILIGAME_WIKI_LIMIT }));
    setError(null);
    setBiligameWikis(codes);
    setText(codes.join(", "));
  };

  return (
    <div className="mt-2 space-y-1">
      <Input
        value={text}
        disabled={disabled}
        aria-label={t("setting:agent.biligame.label")}
        aria-invalid={error ? true : undefined}
        placeholder={t("setting:agent.biligame.placeholder")}
        className="h-8 max-w-sm text-[13px]"
        data-testid="setting-agent-biligame"
        onChange={(event) => { setText(event.target.value); if (error) setError(null); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <div className={cn("text-[11px]", error ? "text-destructive" : "text-muted-foreground")} role={error ? "alert" : undefined}>
        {error ?? t("setting:agent.biligame.hint")}
      </div>
    </div>
  );
}

/** Saved conversations: how many there are, and deleting them all. */
function SessionHistory() {
  const { t } = useTranslation();
  const count = useAgentStore((state) => Object.keys(state.catalog).length);
  const [confirming, setConfirming] = useState(false);
  const clear = async () => {
    const cleared = await clearAllSessions();
    if (cleared) toast.success(t("setting:agent.sessions.cleared"));
    else toast.error(t("setting:agent.sessions.clear_failed"));
  };
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">{t("setting:agent.sessions.label")}</div>
        <p className="text-xs leading-relaxed text-muted-foreground" data-testid="setting-agent-sessions-count">{t("setting:agent.sessions.description", { count })}</p>
      </div>
      <Button type="button" variant="outline" size="sm" className="shrink-0 text-destructive hover:text-destructive" disabled={!count}
        data-testid="setting-agent-sessions-clear" onClick={() => setConfirming(true)}>
        {t("setting:agent.sessions.clear")}
      </Button>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming}
        title={t("setting:agent.sessions.clear_title")} description={t("setting:agent.sessions.clear_description")}
        confirmText={t("setting:agent.sessions.clear_confirm")} cancelText={t("setting:agent.sessions.cancel")}
        onConfirm={() => void clear()} />
    </div>
  );
}

function AgentConfig() {
  const { t } = useTranslation();
  const { enabled, sources, setEnabled, setSource } = useWebLookupStore();

  return (
    <Card className="overflow-auto">
      <CardHeader className="sticky left-0">
        <CardTitle className="text-xl">{t("setting:subtitle.agent_config")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="setting-agent-web" className="text-sm font-medium">{t("setting:agent.web.label")}</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("setting:agent.web.description")}</p>
          </div>
          <Switch id="setting-agent-web" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">{t("setting:agent.sources.title")}</div>
          <div className={cn("divide-y rounded-smooth-lg border", !enabled && "opacity-60")}>
            {WEB_SOURCES.map((source) => (
              <div key={source} className="flex items-start justify-between gap-6 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Label htmlFor={`setting-agent-source-${source}`} className="text-[13px] font-medium">{t(`setting:agent.sources.${source}.name`)}</Label>
                    <span className="text-[11px] text-muted-foreground">{SOURCE_SITES[source]}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(`setting:agent.sources.${source}.description`)}</p>
                  {source === "biligame" && <BiligameWikis disabled={!enabled || !sources.biligame} />}
                </div>
                <Switch
                  id={`setting-agent-source-${source}`}
                  checked={sources[source]}
                  disabled={!enabled}
                  onCheckedChange={(checked) => setSource(source, checked)}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("setting:agent.sources.note")}</p>
        </div>

        <SessionHistory />
      </CardContent>
    </Card>
  );
}

export default AgentConfig;
