import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft, ArrowRight, AudioLines, Copy, DownloadCloud, ExternalLink, FolderDown, Globe, Home, KeyRound, LucideIcon,
  MonitorCheck, Plug, Rocket, Search, Settings, ShieldQuestion, Sparkles, Wallet, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAC_QUARANTINE_COMMAND } from "@/components/update/update-guide";
import { DEEPSEEK_API_KEYS_URL, DEEPSEEK_TOP_UP_URL } from "@/constants/model";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { openExternalPage } from "@/services/ai-error-guide";
import useOnboardingStore from "@/store/useOnboardingStore";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { studioResourcesPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";
import { showToast } from "@/utils/toast";
import { PageHeader, PAGE_EASE, Panel, Rise, SpotlightTile, ToneIcon, TONES, type Tone } from "@/pages/components/page-kit";
import { helpAnchorId, resolveHelpSection, type HelpSectionId } from "./helpNavigation";

const SECTIONS = [
  { id: "quick-start", titleKey: "help:sections.quick_start.title", icon: Rocket, tone: "orange" },
  { id: "cannot-open", titleKey: "help:sections.cannot_open.title", icon: ShieldQuestion, tone: "amber" },
  { id: "models-and-cost", titleKey: "help:sections.models_and_cost.title", icon: KeyRound, tone: "violet" },
  { id: "download-failed", titleKey: "help:sections.download_failed.title", icon: DownloadCloud, tone: "blue" },
  { id: "transcription-failed", titleKey: "help:sections.transcription_failed.title", icon: AudioLines, tone: "teal" },
  { id: "proxy", titleKey: "help:sections.proxy.title", icon: Globe, tone: "cyan" },
  { id: "external-agent", titleKey: "help:sections.external_agent.title", icon: Plug, tone: "green" },
  { id: "system-requirements", titleKey: "help:sections.system_requirements.title", icon: MonitorCheck, tone: "neutral" },
] as const satisfies readonly { id: HelpSectionId; titleKey: string; icon: LucideIcon; tone: Tone }[];

type SectionMeta = (typeof SECTIONS)[number];
const SECTION_META = Object.fromEntries(SECTIONS.map((meta) => [meta.id, meta])) as Record<HelpSectionId, SectionMeta>;

/** A question and its answer; actions and extras follow the text. */
interface Topic { titleKey?: string; bodyKeys: string[]; extra?: ReactNode }

/** Words of a text, lower-cased, for search; Chinese and Japanese match by substring. */
const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();

/**
 * Help for new users: getting started, opening an unsigned app, keys and cost, failed downloads and
 * transcriptions, proxies, external agents and system requirements. Notices elsewhere link to a section
 * with `/help?section=<id>`; the page then scrolls to it and marks it for a moment. The contents rail
 * follows the reading position, and the search box keeps only the topics that mention the words.
 */
const Help: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = resolveHelpSection(searchParams.get("section"));
  const reducedMotion = useReducedMotionPreference();
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const [highlighted, setHighlighted] = useState<HelpSectionId>();
  const [reading, setReading] = useState<HelpSectionId>(section ?? "quick-start");
  const [query, setQuery] = useState("");
  // Opened from a notice ("View help") rather than the main navigation: offer the way back to it.
  // The contents list replaces the address, so going back always returns to that page.
  const [openedFromNotice] = useState(() => Boolean(section) && ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0);
  /** The contents list scrolls by itself (smoothly); the address change it makes must not jump again. */
  const scrolledByListRef = useRef<HelpSectionId | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  const scrollTo = useCallback((id: HelpSectionId, smooth: boolean) => {
    const element = document.getElementById(helpAnchorId(id));
    if (!element) return;
    element.scrollIntoView({ behavior: smooth && !reducedMotion ? "smooth" : "auto", block: "start" });
    setHighlighted(id);
    setReading(id);
  }, [reducedMotion]);

  // Opened from a notice, or the address changed: go to that section.
  useEffect(() => {
    if (!section) return;
    if (scrolledByListRef.current === section) {
      scrolledByListRef.current = undefined;
      return;
    }
    const frame = requestAnimationFrame(() => scrollTo(section, false));
    return () => cancelAnimationFrame(frame);
  }, [section, scrollTo]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  // The rail marks the section being read: the last one whose top has passed under the title bar.
  useEffect(() => {
    const viewport = rootRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const update = () => {
      const top = viewport.getBoundingClientRect().top + 120;
      let current: HelpSectionId = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const element = document.getElementById(helpAnchorId(id));
        if (element && element.offsetParent !== null && element.getBoundingClientRect().top <= top) current = id;
      }
      // At the very end the last section counts, however short it is.
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4) {
        const visible = SECTIONS.filter(({ id }) => document.getElementById(helpAnchorId(id))?.offsetParent);
        if (visible.length) current = visible[visible.length - 1].id;
      }
      setReading(current);
    };
    viewport.addEventListener("scroll", update, { passive: true });
    update();
    return () => viewport.removeEventListener("scroll", update);
  }, [query]);

  const showSection = (id: HelpSectionId) => {
    scrollTo(id, true);
    if (id === section) return;
    scrolledByListRef.current = id;
    setSearchParams({ section: id }, { replace: true });
  };

  const copyCommand = () => {
    navigator.clipboard.writeText(MAC_QUARANTINE_COMMAND)
      .then(() => showToast(t("help:command_copied"), "success"))
      .catch(() => showToast(t("common:error.copy_failed"), "error"));
  };

  const action = (label: string, icon: LucideIcon, onClick: () => void, testId?: string) => {
    const Icon = icon;
    return <Button key={label} type="button" variant="outline" size="sm" className="gap-1.5 bg-background" onClick={onClick} data-testid={testId}>
      <Icon aria-hidden />{label}
    </Button>;
  };

  const topics: Record<Exclude<HelpSectionId, "quick-start" | "system-requirements">, { intro?: string; items: Topic[] }> = {
    "cannot-open": {
      intro: "help:sections.cannot_open.intro",
      items: [
        { titleKey: "help:sections.cannot_open.mac_unverified_title", bodyKeys: ["help:sections.cannot_open.mac_unverified_body"] },
        {
          titleKey: "help:sections.cannot_open.mac_damaged_title", bodyKeys: ["help:sections.cannot_open.mac_damaged_body", "help:sections.cannot_open.mac_damaged_note"],
          extra: <div className="kit-code flex min-w-0 flex-wrap items-center gap-2 rounded-smooth-lg px-3 py-2">
            <code data-testid="help-xattr-command" className="min-w-0 flex-1 select-all font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]">{MAC_QUARANTINE_COMMAND}</code>
            <Button type="button" variant="outline" size="xs" onClick={copyCommand} data-testid="help-copy-xattr" className="bg-background">
              <Copy aria-hidden />{t("help:copy_command")}
            </Button>
          </div>,
        },
        { titleKey: "help:sections.cannot_open.windows_title", bodyKeys: ["help:sections.cannot_open.windows_body"] },
        { titleKey: "help:sections.cannot_open.after_update_title", bodyKeys: ["help:sections.cannot_open.after_update_body"] },
      ],
    },
    "models-and-cost": {
      items: [
        { titleKey: "help:sections.models_and_cost.key_title", bodyKeys: ["help:sections.models_and_cost.key_body"] },
        {
          titleKey: "help:sections.models_and_cost.deepseek_title", bodyKeys: ["help:sections.models_and_cost.deepseek_body"],
          extra: <HelpActions>
            {action(t("help:sections.models_and_cost.deepseek_keys"), ExternalLink, () => openExternalPage(DEEPSEEK_API_KEYS_URL))}
            {action(t("help:sections.models_and_cost.deepseek_topup"), Wallet, () => openExternalPage(DEEPSEEK_TOP_UP_URL))}
          </HelpActions>,
        },
        { titleKey: "help:sections.models_and_cost.token_title", bodyKeys: ["help:sections.models_and_cost.token_body"] },
        { titleKey: "help:sections.models_and_cost.privacy_title", bodyKeys: ["help:sections.models_and_cost.privacy_body"] },
        {
          titleKey: "help:sections.models_and_cost.other_title", bodyKeys: ["help:sections.models_and_cost.other_body"],
          extra: <HelpActions>{action(t("help:sections.models_and_cost.open_model_settings"), Settings, () => navigate(settingPath("model")))}</HelpActions>,
        },
      ],
    },
    "download-failed": {
      intro: "help:sections.download_failed.intro",
      items: [
        { titleKey: "help:sections.download_failed.source_title", bodyKeys: ["help:sections.download_failed.source_body"] },
        { titleKey: "help:sections.download_failed.safe_title", bodyKeys: ["help:sections.download_failed.safe_body"] },
        {
          titleKey: "help:sections.download_failed.check_title", bodyKeys: ["help:sections.download_failed.check_body"],
          extra: <HelpActions>{action(t("help:sections.download_failed.open_network_settings"), Globe, () => navigate(settingPath("proxy")))}</HelpActions>,
        },
      ],
    },
    "transcription-failed": {
      items: [
        { titleKey: "help:sections.transcription_failed.vc_title", bodyKeys: ["help:sections.transcription_failed.vc_body"] },
        { titleKey: "help:sections.transcription_failed.disk_title", bodyKeys: ["help:sections.transcription_failed.disk_body"] },
        { titleKey: "help:sections.transcription_failed.gpu_title", bodyKeys: ["help:sections.transcription_failed.gpu_body"] },
        {
          titleKey: "help:sections.transcription_failed.cpu_title", bodyKeys: ["help:sections.transcription_failed.cpu_body"],
          extra: <HelpActions>{action(t("help:sections.transcription_failed.open_resources"), FolderDown, () => navigate(studioResourcesPath()))}</HelpActions>,
        },
      ],
    },
    proxy: {
      items: [
        { titleKey: "help:sections.proxy.system_title", bodyKeys: ["help:sections.proxy.system_body"] },
        { titleKey: "help:sections.proxy.clash_title", bodyKeys: ["help:sections.proxy.clash_body"] },
        {
          titleKey: "help:sections.proxy.custom_title", bodyKeys: ["help:sections.proxy.custom_body", "help:sections.proxy.test_body"],
          extra: <HelpActions>{action(t("help:sections.proxy.open_network_settings"), Globe, () => navigate(settingPath("proxy")))}</HelpActions>,
        },
      ],
    },
    "external-agent": {
      items: [{
        bodyKeys: ["help:sections.external_agent.body"],
        extra: <HelpActions>{action(t("help:sections.external_agent.open_settings"), Plug, () => navigate(settingPath("external")))}</HelpActions>,
      }],
    },
  };
  const steps = ([1, 2, 3] as const).map((index) => ({
    index, title: t(`help:sections.quick_start.step${index}_title`), body: t(`help:sections.quick_start.step${index}_body`),
    action: t(`help:sections.quick_start.step${index}_action`),
    icon: [Settings, FolderDown, Home][index - 1], tone: (["violet", "teal", "orange"] as const)[index - 1],
    go: [() => navigate(settingPath("model")), () => navigate(studioResourcesPath()), () => navigate("/")][index - 1],
  }));
  const requirements = (["windows", "mac", "disk", "network"] as const).map((key) => ({
    label: t(`help:sections.system_requirements.${key}_label`), value: t(`help:sections.system_requirements.${key}`),
  }));

  // Search: a topic stays when its question or answer has every word; a section when its title does.
  const words = normalize(query).split(" ").filter(Boolean);
  const matches = (...texts: string[]) => { const haystack = normalize(texts.join(" ")); return words.every((word) => haystack.includes(word)); };
  const searching = words.length > 0;
  const visibleTopics = useMemo(() => Object.fromEntries(Object.entries(topics).map(([id, group]) => {
    const sectionTitle = t(SECTION_META[id as HelpSectionId].titleKey);
    const items = !searching || matches(sectionTitle) ? group.items
      : group.items.filter((item) => matches(item.titleKey ? t(item.titleKey) : "", ...item.bodyKeys.map((key) => t(key))));
    return [id, items];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [query, t]) as Record<keyof typeof topics, Topic[]>;
  const quickVisible = !searching || matches(t(SECTION_META["quick-start"].titleKey), t("help:sections.quick_start.intro"), ...steps.flatMap((step) => [step.title, step.body]));
  const requirementsVisible = !searching || matches(t(SECTION_META["system-requirements"].titleKey), ...requirements.flatMap((item) => [item.label, item.value]));
  const shown = (id: HelpSectionId) => id === "quick-start" ? quickVisible : id === "system-requirements" ? requirementsVisible : visibleTopics[id as keyof typeof topics].length > 0;
  const nothing = searching && !SECTIONS.some(({ id }) => shown(id));
  const sectionProps = (id: HelpSectionId) => ({ meta: SECTION_META[id], highlighted: highlighted === id, hidden: !shown(id) });

  return (
    <div ref={rootRef} data-testid="help-page" className="mx-auto max-w-6xl px-4 pt-5 pb-[104px] sm:px-8">
      <PageHeader eyebrow={t("help:eyebrow")} title={t("help:title")} description={t("help:description")}
        before={openedFromNotice ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate(-1)} data-testid="help-back" className="-ml-2 mb-3 gap-1.5 text-muted-foreground">
            <ArrowLeft aria-hidden />{t("menu.back")}
          </Button>
        ) : null}
        actions={<div className="relative w-[min(320px,calc(100vw-2rem))]">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("help:search_placeholder")} aria-label={t("help:search_placeholder")}
            data-testid="help-search" className="h-10 rounded-full bg-card pl-9 pr-9 text-[13px] md:text-[13px] shadow-xs [&::-webkit-search-cancel-button]:hidden"
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} />
          {query && <button type="button" aria-label={t("help:search_clear")} onClick={() => setQuery("")}
            className="absolute top-1/2 right-2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-3.5" />
          </button>}
        </div>} />

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[208px_minmax(0,1fr)]">
        <nav aria-label={t("help:toc")} data-testid="help-toc"
          className="isolate flex flex-wrap gap-1.5 lg:sticky lg:top-14 lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:self-start">
          <p className="kit-eyebrow mb-2 hidden px-2.5 lg:block">{t("help:toc")}</p>
          {SECTIONS.map(({ id, titleKey, icon: Icon, tone }) => {
            const active = reading === id && !searching;
            return <button key={id} type="button" data-section={id} aria-current={section === id ? "location" : undefined} onClick={() => showSection(id)}
              disabled={!shown(id)}
              className={cn("group relative flex items-center gap-2.5 rounded-full border px-3 py-1.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-35",
                "lg:rounded-smooth-lg lg:border-transparent lg:px-2.5 lg:py-1.5",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {active && <motion.span layoutId="help-toc-indicator" aria-hidden className="absolute inset-0 hidden rounded-smooth-lg bg-muted lg:block"
                transition={reducedMotion ? { duration: 0 } : { type: "spring", duration: 0.35, bounce: 0.1 }} />}
              {/* Above every entry's indicator, so the one sliding down never covers the entries it passes. */}
              <span className="relative z-[1] inline-flex"><Icon aria-hidden className="size-3.5" style={{ color: active ? `var(--kit-tone)` : undefined, ["--kit-tone" as string]: TONES[tone] }} /></span>
              <span className="relative z-[1] min-w-0 truncate">{t(titleKey)}</span>
            </button>;
          })}
        </nav>

        <div className="min-w-0 space-y-10">
          <AnimatePresence initial={false}>
            {nothing && <motion.div key="nothing" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center py-16 text-center" data-testid="help-search-empty">
              <ToneIcon icon={Search} tone="neutral" size={44} />
              <p className="mt-3 text-sm font-medium">{t("help:search_empty", { query: query.trim() })}</p>
              <Button type="button" variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={() => setQuery("")}>{t("help:search_clear")}</Button>
            </motion.div>}
          </AnimatePresence>

          <HelpSection {...sectionProps("quick-start")} index={0}>
            <p className="mb-4 max-w-prose text-sm leading-6 text-muted-foreground">{t("help:sections.quick_start.intro")}</p>
            <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {steps.map((step) => (
                <li key={step.index} className="min-w-0">
                  <SpotlightTile tone={step.tone} className="h-full flex-col p-4">
                    <div className="flex items-center justify-between">
                      <ToneIcon icon={step.icon} tone={step.tone} size={34} />
                      <span aria-hidden className="font-mono text-[28px] font-semibold leading-none tabular-nums text-foreground/[0.08]">{String(step.index).padStart(2, "0")}</span>
                    </div>
                    <h3 className="mt-3 text-[14px] font-semibold">{step.title}</h3>
                    <p className="mt-1 flex-1 text-[12.5px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{step.body}</p>
                    <button type="button" onClick={step.go} className="mt-3 inline-flex w-fit items-center gap-1 text-[12.5px] font-medium text-foreground/85 underline-offset-4 hover:underline">
                      {step.action}<ArrowRight aria-hidden className="size-3.5" />
                    </button>
                  </SpotlightTile>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" className="gap-1.5" onClick={openWizard} data-testid="help-reopen-onboarding">
                <Sparkles aria-hidden />{t("help:sections.quick_start.reopen")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("help:sections.quick_start.reopen_hint")}</span>
            </div>
          </HelpSection>

          {(Object.keys(topics) as (keyof typeof topics)[]).map((id, index) => (
            <HelpSection key={id} {...sectionProps(id)} index={index + 1}>
              {topics[id].intro && (!searching || visibleTopics[id].length === topics[id].items.length) && <p className="mb-3 max-w-prose text-sm leading-6 text-muted-foreground">{t(topics[id].intro!)}</p>}
              <Panel>
                {visibleTopics[id].map((topic) => <HelpTopic key={topic.titleKey ?? topic.bodyKeys[0]} title={topic.titleKey ? t(topic.titleKey) : undefined} words={words}>
                  {topic.bodyKeys.map((key) => <p key={key}>{t(key)}</p>)}
                  {topic.extra}
                </HelpTopic>)}
              </Panel>
            </HelpSection>
          ))}

          <HelpSection {...sectionProps("system-requirements")} index={SECTIONS.length - 1}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {requirements.map((item) => (
                <Panel key={item.label} className="px-4 py-3.5">
                  <div className="kit-eyebrow">{item.label}</div>
                  <div className="mt-2 text-[13px] leading-5 text-foreground/90 [overflow-wrap:anywhere]">{item.value}</div>
                </Panel>
              ))}
            </div>
          </HelpSection>
        </div>
      </div>
    </div>
  );
};

function HelpSection({ meta, highlighted, hidden, index, children }: { meta: SectionMeta; highlighted: boolean; hidden: boolean; index: number; children: ReactNode }) {
  const { t } = useTranslation();
  const anchor = helpAnchorId(meta.id);
  return (
    <section
      id={anchor}
      data-help-section={meta.id}
      data-highlighted={highlighted || undefined}
      aria-labelledby={`${anchor}-title`}
      hidden={hidden}
      // Clears the transparent title bar when scrolled to.
      className="scroll-mt-16"
    >
      <Rise index={index}>
        <h2 id={`${anchor}-title`} className="mb-3.5 flex items-center gap-3 text-[18px] font-semibold tracking-tight">
          <ToneIcon icon={meta.icon} tone={meta.tone} size={32} />
          {t(meta.titleKey)}
        </h2>
        <div className={cn("relative rounded-smooth-2xl transition-[box-shadow] duration-500", highlighted && "shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_16%,transparent)]")}
          style={{ borderRadius: 20 }}>
          {children}
        </div>
      </Rise>
    </section>
  );
}

/** Marks the searched words in a title. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const marks: [number, number][] = [];
  for (const word of words) {
    let from = 0;
    for (let at = lower.indexOf(word, from); at >= 0; at = lower.indexOf(word, from)) { marks.push([at, at + word.length]); from = at + word.length; }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of marks) {
    if (start < cursor) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start} className="rounded-[3px] bg-amber-300/40 px-0.5 text-inherit dark:bg-amber-400/25">{text.slice(start, end)}</mark>);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function HelpTopic({ title, words, children }: { title?: string; words: string[]; children: ReactNode }) {
  return (
    <motion.div layout="position" className="kit-row items-start" transition={{ duration: 0.25, ease: PAGE_EASE }}>
      <div className="min-w-0 flex-1 space-y-1.5">
        {title && <h3 className="m-0 text-[14px] font-semibold text-foreground"><Highlight text={title} words={words} /></h3>}
        <div className="space-y-2 text-[13px] leading-6 text-muted-foreground [overflow-wrap:anywhere]">{children}</div>
      </div>
    </motion.div>
  );
}

function HelpActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 pt-1">{children}</div>;
}

export default Help;
