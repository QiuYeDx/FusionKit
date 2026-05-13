import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UPDATE_CHECK_EVENT, UPDATE_STATUS_EVENT } from "@/components/update";
import FusionKitLogo from "@/assets/FusionKit.svg";
import {
  RefreshCw,
  Github,
  ExternalLink,
  FileText,
  Mail,
  Info,
  ArrowUpRight,
} from "lucide-react";

const REPO_URL = "https://github.com/QiuYeDx/FusionKit";
const AUTHOR_URL = "https://qiuvision.com";
const BLOG_URL = "https://blog.qiuyedx.com";
const CONTACT_EMAIL = "me@qiuyedx.com";
const RELEASES_URL = `${REPO_URL}/releases`;

const openExternal = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

const About: React.FC = () => {
  const { t } = useTranslation();
  const appVersion = import.meta.env.VITE_APP_VERSION || "-";
  const [updateChecking, setUpdateChecking] = useState(false);

  const handleManualCheck = () => {
    setUpdateChecking(true);
    window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ checking: boolean; source: "manual" | "auto" }>
      ).detail;
      if (!detail || detail.source !== "manual") return;
      setUpdateChecking(detail.checking);
    };

    window.addEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(UPDATE_STATUS_EVENT, handler as EventListener);
    };
  }, []);

  return (
    <div className="px-4 sm:px-8 pt-6 pb-[80px] max-w-3xl mx-auto">
      {/* Page header */}
      <div className="mb-5">
        <div className="text-2xl font-semibold tracking-tight">
          {t("about:title")}
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          {t("about:description")}
        </div>
      </div>

      {/* Hero card */}
      <div className="relative overflow-hidden rounded-xl border bg-card mb-3">
        {/* radial accent */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-10 -right-10 h-60 w-60 rounded-full"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)",
          }}
        />

        <div className="relative p-6">
          <div className="flex items-start gap-5">
            <img
              src={FusionKitLogo}
              alt="FusionKit Logo"
              className="h-16 w-16 rounded-2xl shadow-sm shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-semibold tracking-tight m-0">
                  FusionKit
                </h2>
                <Badge variant="outline" className="font-mono text-[11px]">
                  v{appVersion}
                </Badge>
                <Badge
                  variant="outline"
                  className="text-[11px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                >
                  {t("about:badge.latest")}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-prose">
                {t("about:tagline")}
              </p>

              <div className="flex gap-2 mt-4 flex-wrap">
                <Button
                  size="sm"
                  onClick={handleManualCheck}
                  disabled={updateChecking}
                  aria-busy={updateChecking}
                  className="gap-1.5"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${updateChecking ? "animate-spin" : ""}`}
                  />
                  {updateChecking
                    ? t("common:update.checking")
                    : t("common:action.check_update")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openExternal(REPO_URL)}
                  className="gap-1.5"
                >
                  <Github className="h-3.5 w-3.5" />
                  {t("about:buttons.repo")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openExternal(RELEASES_URL)}
                  className="gap-1.5"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("about:buttons.changelog")}
                </Button>
              </div>
            </div>
          </div>

          {/* Quick stats strip */}
          <div className="mt-6 pt-4 border-t grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat
              label={t("about:stats.platform")}
              value="macOS · Windows"
            />
            <Stat
              label={t("about:stats.license")}
              value="PolyForm NC 1.0"
            />
            <Stat
              label={t("about:stats.build")}
              value={`v${appVersion}`}
              mono
            />
            <Stat
              label={t("about:stats.stack")}
              value="Electron · React 19"
            />
          </div>
        </div>
      </div>

      {/* Link grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <LinkCard
          icon={<Github className="h-[18px] w-[18px]" />}
          title={t("about:links.repo.title")}
          url="github.com/QiuYeDx/FusionKit"
          desc={t("about:links.repo.desc")}
          href={REPO_URL}
          tone="text-foreground"
        />
        <LinkCard
          icon={<ExternalLink className="h-[18px] w-[18px]" />}
          title={t("about:links.author.title")}
          url="qiuvision.com"
          desc={t("about:links.author.desc")}
          href={AUTHOR_URL}
          tone="text-sky-600 dark:text-sky-400"
          accentRgb="14 165 233"
        />
        <LinkCard
          icon={<FileText className="h-[18px] w-[18px]" />}
          title={t("about:links.blog.title")}
          url="blog.qiuyedx.com"
          desc={t("about:links.blog.desc")}
          href={BLOG_URL}
          tone="text-violet-600 dark:text-violet-400"
          accentRgb="139 92 246"
        />
        <LinkCard
          icon={<Mail className="h-[18px] w-[18px]" />}
          title={t("about:links.contact.title")}
          url={CONTACT_EMAIL}
          desc={t("about:links.contact.desc")}
          href={`mailto:${CONTACT_EMAIL}`}
          tone="text-amber-600 dark:text-amber-400"
          accentRgb="245 158 11"
        />
      </div>

      {/* Tech stack section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("about:subtitle.tech_stack")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-7 gap-y-1">
            {[
              [t("about:tech.framework"), "Electron 33 + React 19"],
              [t("about:tech.language"), "TypeScript 5.4"],
              [t("about:tech.build_tool"), "Vite 5"],
              [t("about:tech.style"), "Tailwind CSS 4 + shadcn/ui"],
              [t("about:tech.state"), "Zustand"],
              [t("about:tech.ai"), "Vercel AI SDK"],
              [t("about:tech.i18n"), "i18next"],
              [t("about:tech.pkg"), "pnpm"],
            ].map(([k, v]) => (
              <div
                key={k}
                className="flex justify-between items-center py-1.5 border-b border-dashed last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0"
              >
                <span className="text-xs text-muted-foreground">{k}</span>
                <span className="text-xs font-mono text-foreground/80">{v}</span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-dashed bg-muted/40 px-3 py-2.5 flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="leading-relaxed">
              {t("about:license_note")}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={`mt-1 text-[13px] font-medium text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

interface LinkCardProps {
  icon: React.ReactNode;
  title: string;
  url: string;
  desc: string;
  href: string;
  tone: string;
  accentRgb?: string;
}

function LinkCard({ icon, title, url, desc, href, tone, accentRgb }: LinkCardProps) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    openExternal(href);
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      className="group flex items-center gap-3.5 rounded-xl border bg-card px-4 py-3.5 transition-all hover:bg-accent/40 hover:border-foreground/20 no-underline"
      title={desc}
    >
      <div
        className={`h-9 w-9 rounded-lg inline-flex items-center justify-center shrink-0 ${tone}`}
        style={{
          background: accentRgb
            ? `rgb(${accentRgb} / 0.12)`
            : "color-mix(in oklch, var(--foreground) 8%, transparent)",
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-semibold text-foreground truncate">
          {title}
        </div>
        <div className="text-[11.5px] font-mono text-muted-foreground mt-0.5 truncate">
          {url}
        </div>
      </div>
      <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
    </a>
  );
}

export default About;
