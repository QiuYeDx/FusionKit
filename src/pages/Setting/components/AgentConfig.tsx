import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import useAgentStore from "@/store/agent/useAgentStore";
import { clearAllSessions } from "@/agent/session-persistence";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import useWebLookupStore, { BILIGAME_WIKI_LIMIT, parseBiligameWikis } from "@/store/useWebLookupStore";
import { WEB_SOURCES, type WebSource } from "@/web-lookup/contract";
import { BookOpen, Gamepad2, Globe2, History, Search, Sparkle } from "lucide-react";
import { Panel, PanelRow, PageSection, type Tone } from "@/pages/components/page-kit";
import type { LucideIcon } from "lucide-react";

const SOURCE_ICONS: Record<WebSource, { icon: LucideIcon; tone: Tone }> = {
  wikipedia: { icon: BookOpen, tone: "neutral" },
  moegirl: { icon: Sparkle, tone: "violet" },
  baidu_baike: { icon: BookOpen, tone: "blue" },
  biligame: { icon: Gamepad2, tone: "cyan" },
  bing: { icon: Search, tone: "teal" },
};

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
    <div className="space-y-1">
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
    <Panel>
      <PanelRow icon={History} tone="amber" label={t("setting:agent.sessions.label")}
        description={<span data-testid="setting-agent-sessions-count">{t("setting:agent.sessions.description", { count })}</span>}
        control={<Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={!count}
          data-testid="setting-agent-sessions-clear" onClick={() => setConfirming(true)}>
          {t("setting:agent.sessions.clear")}
        </Button>} />
      <ConfirmDialog open={confirming} onOpenChange={setConfirming}
        title={t("setting:agent.sessions.clear_title")} description={t("setting:agent.sessions.clear_description")}
        confirmText={t("setting:agent.sessions.clear_confirm")} cancelText={t("setting:agent.sessions.cancel")}
        onConfirm={() => void clear()} />
    </Panel>
  );
}

function AgentConfig() {
  const { t } = useTranslation();
  const { enabled, sources, setEnabled, setSource } = useWebLookupStore();

  return <>
    <PageSection title={t("setting:agent.web.title")} description={t("setting:agent.web.section_hint")}>
      <Panel>
        <PanelRow icon={Globe2} tone="teal" htmlFor="setting-agent-web" label={t("setting:agent.web.label")} description={t("setting:agent.web.description")}
          control={<Switch id="setting-agent-web" checked={enabled} onCheckedChange={setEnabled} />} />
      </Panel>
      <div className={cn("mt-2.5 transition-opacity duration-200", !enabled && "opacity-55")}>
        <div className="mb-2 mt-4 px-0.5 text-xs font-medium text-muted-foreground">{t("setting:agent.sources.title")}</div>
        <Panel>
          {WEB_SOURCES.map((source) => (
            <PanelRow key={source} icon={SOURCE_ICONS[source].icon} tone={SOURCE_ICONS[source].tone}
              label={<span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <label htmlFor={`setting-agent-source-${source}`} className="cursor-pointer">{t(`setting:agent.sources.${source}.name`)}</label>
                <span className="font-mono text-[11px] font-normal text-muted-foreground">{SOURCE_SITES[source]}</span>
              </span>}
              description={t(`setting:agent.sources.${source}.description`)}
              control={<Switch id={`setting-agent-source-${source}`} checked={sources[source]} disabled={!enabled} onCheckedChange={(checked) => setSource(source, checked)} />}>
              {source === "biligame" ? <BiligameWikis disabled={!enabled || !sources.biligame} /> : undefined}
            </PanelRow>
          ))}
        </Panel>
        <p className="mt-2 px-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{t("setting:agent.sources.note")}</p>
      </div>
    </PageSection>

    <PageSection title={t("setting:agent.sessions.title")} description={t("setting:agent.sessions.section_hint")}>
      <SessionHistory />
    </PageSection>
  </>;
}

export default AgentConfig;
