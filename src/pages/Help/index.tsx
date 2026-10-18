import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  AudioLines,
  Copy,
  DownloadCloud,
  ExternalLink,
  FolderDown,
  Globe,
  Home,
  KeyRound,
  LucideIcon,
  MonitorCheck,
  Plug,
  Rocket,
  Settings,
  ShieldQuestion,
  Sparkles,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAC_QUARANTINE_COMMAND } from "@/components/update/update-guide";
import { DEEPSEEK_API_KEYS_URL, DEEPSEEK_TOP_UP_URL } from "@/constants/model";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { openExternalPage } from "@/services/ai-error-guide";
import useOnboardingStore from "@/store/useOnboardingStore";
import { settingPath } from "@/pages/Setting/settingNavigation";
import { studioResourcesPath } from "@/pages/Tools/Subtitle/SubtitleStudio/navigation";
import { showToast } from "@/utils/toast";
import { helpAnchorId, resolveHelpSection, type HelpSectionId } from "./helpNavigation";

const SECTIONS = [
  { id: "quick-start", titleKey: "help:sections.quick_start.title", icon: Rocket },
  { id: "cannot-open", titleKey: "help:sections.cannot_open.title", icon: ShieldQuestion },
  { id: "models-and-cost", titleKey: "help:sections.models_and_cost.title", icon: KeyRound },
  { id: "download-failed", titleKey: "help:sections.download_failed.title", icon: DownloadCloud },
  { id: "transcription-failed", titleKey: "help:sections.transcription_failed.title", icon: AudioLines },
  { id: "proxy", titleKey: "help:sections.proxy.title", icon: Globe },
  { id: "external-agent", titleKey: "help:sections.external_agent.title", icon: Plug },
  { id: "system-requirements", titleKey: "help:sections.system_requirements.title", icon: MonitorCheck },
] as const satisfies readonly { id: HelpSectionId; titleKey: string; icon: LucideIcon }[];

type SectionMeta = (typeof SECTIONS)[number];

const SECTION_META = Object.fromEntries(SECTIONS.map((meta) => [meta.id, meta])) as Record<HelpSectionId, SectionMeta>;

/**
 * Help for new users: getting started, opening an unsigned app, keys and cost, failed downloads
 * and transcriptions, proxies, external agents and system requirements. Notices elsewhere link to
 * a section with `/help?section=<id>`; the page then scrolls to it and marks it for a moment.
 */
const Help: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = resolveHelpSection(searchParams.get("section"));
  const reducedMotion = useReducedMotionPreference();
  const openWizard = useOnboardingStore((state) => state.openWizard);
  const [highlighted, setHighlighted] = useState<HelpSectionId>();
  // Opened from a notice ("View help") rather than the main navigation: offer the way back to it.
  // The contents list replaces the address, so going back always returns to that page.
  const [openedFromNotice] = useState(() => Boolean(section) && ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0);
  /** The contents list scrolls by itself (smoothly); the address change it makes must not jump again. */
  const scrolledByListRef = useRef<HelpSectionId | undefined>(undefined);

  const scrollTo = useCallback((id: HelpSectionId, smooth: boolean) => {
    const element = document.getElementById(helpAnchorId(id));
    if (!element) return;
    element.scrollIntoView({ behavior: smooth && !reducedMotion ? "smooth" : "auto", block: "start" });
    setHighlighted(id);
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

  const sectionProps = (id: HelpSectionId) => ({ meta: SECTION_META[id], highlighted: highlighted === id });

  return (
    <div data-testid="help-page" className="px-4 sm:px-8 pt-6 pb-[80px] max-w-3xl mx-auto">
      <div className="mb-5">
        {openedFromNotice ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate(-1)} data-testid="help-back" className="-ml-2 mb-2 gap-1.5 text-muted-foreground">
            <ArrowLeft aria-hidden />{t("menu.back")}
          </Button>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">{t("help:title")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-prose">{t("help:description")}</p>
      </div>

      <nav aria-label={t("help:toc")} data-testid="help-toc" className="mb-4 flex flex-wrap gap-1.5">
        {SECTIONS.map(({ id, titleKey, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            size="sm"
            data-section={id}
            aria-current={section === id ? "location" : undefined}
            onClick={() => showSection(id)}
            className="gap-1.5 rounded-full text-muted-foreground hover:text-foreground aria-[current=location]:text-foreground"
          >
            <Icon aria-hidden />
            {t(titleKey)}
          </Button>
        ))}
      </nav>

      <div className="space-y-3">
        <HelpSection {...sectionProps("quick-start")}>
          <p className="text-muted-foreground">{t("help:sections.quick_start.intro")}</p>
          <ol className="space-y-4">
            <HelpStep index={1} title={t("help:sections.quick_start.step1_title")} body={t("help:sections.quick_start.step1_body")}>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(settingPath("model"))}>
                <Settings aria-hidden />{t("help:sections.quick_start.step1_action")}
              </Button>
            </HelpStep>
            <HelpStep index={2} title={t("help:sections.quick_start.step2_title")} body={t("help:sections.quick_start.step2_body")}>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(studioResourcesPath())}>
                <FolderDown aria-hidden />{t("help:sections.quick_start.step2_action")}
              </Button>
            </HelpStep>
            <HelpStep index={3} title={t("help:sections.quick_start.step3_title")} body={t("help:sections.quick_start.step3_body")}>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/")}>
                <Home aria-hidden />{t("help:sections.quick_start.step3_action")}
              </Button>
            </HelpStep>
          </ol>
          <div className="border-t pt-4">
            <Button type="button" size="sm" className="gap-1.5" onClick={openWizard} data-testid="help-reopen-onboarding">
              <Sparkles aria-hidden />{t("help:sections.quick_start.reopen")}
            </Button>
          </div>
        </HelpSection>

        <HelpSection {...sectionProps("cannot-open")}>
          <p className="text-muted-foreground">{t("help:sections.cannot_open.intro")}</p>
          <HelpTopic title={t("help:sections.cannot_open.mac_unverified_title")}>
            <p>{t("help:sections.cannot_open.mac_unverified_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.cannot_open.mac_damaged_title")}>
            <p>{t("help:sections.cannot_open.mac_damaged_body")}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-smooth-lg border bg-muted/40 px-3 py-2">
              <code data-testid="help-xattr-command" className="min-w-0 flex-1 select-all font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
                {MAC_QUARANTINE_COMMAND}
              </code>
              <Button type="button" variant="outline" size="xs" onClick={copyCommand} data-testid="help-copy-xattr" className="bg-background">
                <Copy aria-hidden />{t("help:copy_command")}
              </Button>
            </div>
            <p className="text-xs leading-5">{t("help:sections.cannot_open.mac_damaged_note")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.cannot_open.windows_title")}>
            <p>{t("help:sections.cannot_open.windows_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.cannot_open.after_update_title")}>
            <p>{t("help:sections.cannot_open.after_update_body")}</p>
          </HelpTopic>
        </HelpSection>

        <HelpSection {...sectionProps("models-and-cost")}>
          <HelpTopic title={t("help:sections.models_and_cost.key_title")}>
            <p>{t("help:sections.models_and_cost.key_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.models_and_cost.deepseek_title")}>
            <p>{t("help:sections.models_and_cost.deepseek_body")}</p>
            <HelpActions>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => openExternalPage(DEEPSEEK_API_KEYS_URL)}>
                <ExternalLink aria-hidden />{t("help:sections.models_and_cost.deepseek_keys")}
              </Button>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => openExternalPage(DEEPSEEK_TOP_UP_URL)}>
                <Wallet aria-hidden />{t("help:sections.models_and_cost.deepseek_topup")}
              </Button>
            </HelpActions>
          </HelpTopic>
          <HelpTopic title={t("help:sections.models_and_cost.token_title")}>
            <p>{t("help:sections.models_and_cost.token_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.models_and_cost.privacy_title")}>
            <p>{t("help:sections.models_and_cost.privacy_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.models_and_cost.other_title")}>
            <p>{t("help:sections.models_and_cost.other_body")}</p>
            <HelpActions>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(settingPath("model"))}>
                <Settings aria-hidden />{t("help:sections.models_and_cost.open_model_settings")}
              </Button>
            </HelpActions>
          </HelpTopic>
        </HelpSection>

        <HelpSection {...sectionProps("download-failed")}>
          <p className="text-muted-foreground">{t("help:sections.download_failed.intro")}</p>
          <HelpTopic title={t("help:sections.download_failed.source_title")}>
            <p>{t("help:sections.download_failed.source_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.download_failed.safe_title")}>
            <p>{t("help:sections.download_failed.safe_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.download_failed.check_title")}>
            <p>{t("help:sections.download_failed.check_body")}</p>
            <HelpActions>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(settingPath("proxy"))}>
                <Globe aria-hidden />{t("help:sections.download_failed.open_network_settings")}
              </Button>
            </HelpActions>
          </HelpTopic>
        </HelpSection>

        <HelpSection {...sectionProps("transcription-failed")}>
          <HelpTopic title={t("help:sections.transcription_failed.vc_title")}>
            <p>{t("help:sections.transcription_failed.vc_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.transcription_failed.disk_title")}>
            <p>{t("help:sections.transcription_failed.disk_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.transcription_failed.gpu_title")}>
            <p>{t("help:sections.transcription_failed.gpu_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.transcription_failed.cpu_title")}>
            <p>{t("help:sections.transcription_failed.cpu_body")}</p>
            <HelpActions>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(studioResourcesPath())}>
                <FolderDown aria-hidden />{t("help:sections.transcription_failed.open_resources")}
              </Button>
            </HelpActions>
          </HelpTopic>
        </HelpSection>

        <HelpSection {...sectionProps("proxy")}>
          <HelpTopic title={t("help:sections.proxy.system_title")}>
            <p>{t("help:sections.proxy.system_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.proxy.clash_title")}>
            <p>{t("help:sections.proxy.clash_body")}</p>
          </HelpTopic>
          <HelpTopic title={t("help:sections.proxy.custom_title")}>
            <p>{t("help:sections.proxy.custom_body")}</p>
            <p>{t("help:sections.proxy.test_body")}</p>
            <HelpActions>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(settingPath("proxy"))}>
                <Globe aria-hidden />{t("help:sections.proxy.open_network_settings")}
              </Button>
            </HelpActions>
          </HelpTopic>
        </HelpSection>

        <HelpSection {...sectionProps("external-agent")}>
          <p className="text-muted-foreground [overflow-wrap:anywhere]">{t("help:sections.external_agent.body")}</p>
          <HelpActions>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(settingPath("external"))}>
              <Plug aria-hidden />{t("help:sections.external_agent.open_settings")}
            </Button>
          </HelpActions>
        </HelpSection>

        <HelpSection {...sectionProps("system-requirements")}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            {([
              ["windows_label", "windows"],
              ["mac_label", "mac"],
              ["disk_label", "disk"],
              ["network_label", "network"],
            ] as const).map(([label, value]) => (
              <React.Fragment key={label}>
                <dt className="font-medium text-foreground">{t(`help:sections.system_requirements.${label}`)}</dt>
                <dd className="text-muted-foreground [overflow-wrap:anywhere]">{t(`help:sections.system_requirements.${value}`)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </HelpSection>
      </div>
    </div>
  );
};

function HelpSection({ meta, highlighted, children }: { meta: SectionMeta; highlighted: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const anchor = helpAnchorId(meta.id);
  const Icon = meta.icon;
  return (
    <section
      id={anchor}
      data-help-section={meta.id}
      data-highlighted={highlighted || undefined}
      aria-labelledby={`${anchor}-title`}
      // Clears the transparent title bar when scrolled to.
      className={cn(
        "scroll-mt-14 rounded-smooth-xl border bg-card p-5 transition-[box-shadow,border-color] duration-500",
        highlighted && "border-primary/40 shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_14%,transparent)]",
      )}
    >
      <h2 id={`${anchor}-title`} className="m-0 flex items-center gap-2.5 text-base font-semibold">
        <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-smooth-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        {t(meta.titleKey)}
      </h2>
      <div className="mt-3 space-y-4 text-sm leading-6">{children}</div>
    </section>
  );
}

function HelpTopic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="m-0 text-sm font-medium text-foreground">{title}</h3>
      <div className="space-y-2 text-muted-foreground [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function HelpStep({ index, title, body, children }: { index: number; title: string; body: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs tabular-nums">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="m-0 text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{body}</p>
        <HelpActions>{children}</HelpActions>
      </div>
    </li>
  );
}

function HelpActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 pt-0.5">{children}</div>;
}

export default Help;
