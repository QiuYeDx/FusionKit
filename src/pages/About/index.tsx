import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { UPDATE_CHECK_EVENT, UPDATE_OPEN_EVENT, UPDATE_STATUS_EVENT, useAppUpdateState } from "@/components/update";
import type { AppUpdateState } from "@/app-update/contract";
import FusionKitLogo from "@/assets/FusionKit.svg";
import { ArrowUpRight, BookText, Github, Globe, Info, Mail, RefreshCw, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader, PageSection, Panel, Rise, SpotlightTile, ToneIcon, type Tone } from "@/pages/components/page-kit";

const REPO_URL = "https://github.com/QiuYeDx/FusionKit";
const AUTHOR_URL = "https://qiuvision.com";
const BLOG_URL = "https://blog.qiuyedx.com";
const CONTACT_EMAIL = "me@qiuyedx.com";
const RELEASES_URL = `${REPO_URL}/releases`;

const openExternal = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

/** "Latest" only after a check said so; a found, downloading or downloaded version opens the update dialog. */
function UpdateBadge({ state }: { state: AppUpdateState | undefined }) {
  const { t } = useTranslation();
  if (state?.phase === "up_to_date") {
    return (
      <Badge variant="outline" data-testid="about-update-badge" data-phase={state.phase}
        className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-[11px] text-emerald-700 dark:text-emerald-400">
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />{t("about:badge.latest")}
      </Badge>
    );
  }
  // A failed download or install still has a new version waiting; the dialog says what to do.
  const found = state?.phase === "available" || (state?.phase === "error" && state.error?.during !== "check" && !!state.latestVersion);
  const label = found
    ? t("about:badge.available", { version: state?.latestVersion ?? "-" })
    : state?.phase === "downloading"
      ? t("about:badge.downloading", { percent: Math.round(state.progress?.percent ?? 0) })
      : state?.phase === "downloaded" || state?.phase === "installing"
        ? t("about:badge.downloaded")
        : null;
  if (!label) return null;
  return (
    <Badge asChild variant="outline" className="cursor-pointer gap-1.5 border-sky-500/30 bg-sky-500/10 text-[11px] text-sky-700 hover:bg-sky-500/20 dark:text-sky-400">
      <button type="button" data-testid="about-update-badge" data-phase={state?.phase} onClick={() => window.dispatchEvent(new Event(UPDATE_OPEN_EVENT))}>
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-sky-500 opacity-60 motion-reduce:animate-none" />
          <span className="relative size-1.5 rounded-full bg-sky-500" />
        </span>
        {label}
      </button>
    </Badge>
  );
}

interface LinkItem { icon: LucideIcon; tone: Tone; titleKey: string; descKey: string; url: string; href: string }

const LINKS = [
  { icon: Github, tone: "neutral", titleKey: "about:links.repo.title", descKey: "about:links.repo.desc", url: "github.com/QiuYeDx/FusionKit", href: REPO_URL },
  { icon: Globe, tone: "blue", titleKey: "about:links.author.title", descKey: "about:links.author.desc", url: "qiuvision.com", href: AUTHOR_URL },
  { icon: BookText, tone: "violet", titleKey: "about:links.blog.title", descKey: "about:links.blog.desc", url: "blog.qiuyedx.com", href: BLOG_URL },
  { icon: Mail, tone: "amber", titleKey: "about:links.contact.title", descKey: "about:links.contact.desc", url: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}` },
] as const satisfies readonly LinkItem[];

const About: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = import.meta.env.VITE_APP_VERSION || "-";
  const electronVersion = import.meta.env.VITE_ELECTRON_VERSION || "-";
  const reactVersion = import.meta.env.VITE_REACT_VERSION || "-";
  const reactMajorVersion = reactVersion.match(/^\d+/)?.[0];
  const stackSummary = reactMajorVersion ? `Electron · React ${reactMajorVersion}` : "Electron · React";
  const [updateChecking, setUpdateChecking] = useState(false);
  const updateState = useAppUpdateState();

  const handleManualCheck = () => {
    setUpdateChecking(true);
    window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ checking: boolean; source: "manual" | "auto" }>).detail;
      if (!detail || detail.source !== "manual") return;
      setUpdateChecking(detail.checking);
    };
    window.addEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
    return () => window.removeEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
  }, []);

  const stats = [
    [t("about:stats.platform"), "macOS · Windows"],
    [t("about:stats.license"), "PolyForm NC 1.0"],
    [t("about:stats.build"), `v${appVersion}`],
    [t("about:stats.stack"), stackSummary],
  ] as const;
  const tech = [
    [t("about:tech.framework"), `Electron ${electronVersion}`],
    [t("about:tech.ui"), `React ${reactVersion}`],
    [t("about:tech.language"), "TypeScript"],
    [t("about:tech.build_tool"), "Vite"],
    [t("about:tech.style"), "Tailwind CSS 4 + shadcn/ui"],
    [t("about:tech.state"), "Zustand"],
    [t("about:tech.ai"), "Vercel AI SDK"],
    [t("about:tech.i18n"), "i18next"],
  ] as const;

  return (
    <div className="mx-auto max-w-5xl px-4 pt-5 pb-[104px] sm:px-8" data-testid="about-page">
      <PageHeader eyebrow={t("about:eyebrow")} title={t("about:title")} description={t("about:description")} />

      <Rise index={0} className="mt-8">
        <SmoothCorners radius={24} smoothing={0.72} className="about-hero">
          <div aria-hidden className="about-hero-mesh" />
          <div aria-hidden className="about-hero-veil" />
          <div className="relative flex flex-col gap-6 p-6 sm:flex-row sm:items-start sm:p-8">
            <div className="about-logo">
              <img src={FusionKitLogo} alt="FusionKit Logo" className="size-[76px] rounded-smooth-2xl" style={{ borderRadius: 20 }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="m-0 text-[30px] font-semibold leading-tight tracking-tight">FusionKit</h2>
                <span className="rounded-full border bg-background/70 px-2 py-0.5 font-mono text-[11.5px] text-foreground/80 backdrop-blur-sm">v{appVersion}</span>
                <UpdateBadge state={updateState} />
              </div>
              <p className="mt-2 max-w-xl text-[14px] leading-6 text-muted-foreground">{t("about:tagline")}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button size="sm" onClick={handleManualCheck} disabled={updateChecking} aria-busy={updateChecking} className="h-9 gap-1.5 px-3.5">
                  <RefreshCw className={`h-3.5 w-3.5 ${updateChecking ? "animate-spin" : ""}`} />
                  {updateChecking ? t("common:update.checking") : t("common:action.check_update")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => openExternal(REPO_URL)} className="h-9 gap-1.5 bg-background/70 px-3.5 backdrop-blur-sm">
                  <Github className="h-3.5 w-3.5" />{t("about:buttons.repo")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openExternal(RELEASES_URL)} className="h-9 gap-1.5 px-3.5">
                  <ScrollText className="h-3.5 w-3.5" />{t("about:buttons.changelog")}
                </Button>
              </div>
            </div>
          </div>
          <dl className="relative grid grid-cols-2 border-t border-border/70 sm:grid-cols-4">
            {stats.map(([label, value], index) => (
              <div key={label} className={`px-6 py-4 sm:px-8 ${index % 2 ? "border-l border-border/70" : ""} ${index >= 2 ? "max-sm:border-t max-sm:border-border/70" : ""} ${index === 2 ? "sm:border-l sm:border-border/70" : ""}`}>
                <dt className="kit-eyebrow">{label}</dt>
                <dd className={`mt-2 text-[13.5px] font-medium ${label === t("about:stats.build") ? "font-mono" : ""}`}>{value}</dd>
              </div>
            ))}
          </dl>
        </SmoothCorners>
      </Rise>

      <Rise index={1} className="mt-10">
        <PageSection title={t("about:subtitle.links")} description={t("about:subtitle.links_hint")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {LINKS.map((link) => (
              <SpotlightTile key={link.href} as="a" tone={link.tone} href={link.href} title={t(link.descKey)}
                onClick={(event) => { event.preventDefault(); openExternal(link.href); }}
                className="group items-center gap-3.5 px-4 py-4 no-underline">
                <ToneIcon icon={link.icon} tone={link.tone} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-foreground">{t(link.titleKey)}</div>
                  <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{t(link.descKey)}</div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">{link.url}</div>
                </div>
                <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
              </SpotlightTile>
            ))}
          </div>
        </PageSection>
      </Rise>

      <Rise index={2} className="mt-10">
        <PageSection title={t("about:subtitle.tech_stack")} description={t("about:subtitle.tech_hint")}>
          <Panel>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              {tech.map(([label, value], index) => (
                <div key={label} className={`flex items-center justify-between gap-4 px-4 py-3 ${index >= 2 ? "border-t" : index === 1 ? "max-sm:border-t" : ""} ${index % 2 ? "sm:border-l" : ""}`}>
                  <span className="text-[12.5px] text-muted-foreground">{label}</span>
                  <span className="min-w-0 truncate text-right font-mono text-[12px] text-foreground/85">{value}</span>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2.5 border-t px-4 py-3.5 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("about:license_note")}</span>
            </div>
          </Panel>
        </PageSection>
      </Rise>
    </div>
  );
};

export default About;
