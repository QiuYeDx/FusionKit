import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { Bot, Globe, Cpu, LucideIcon, Plug, SlidersHorizontal } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { PageHeader, PAGE_EASE, ToneIcon, type Tone } from "@/pages/components/page-kit";
import GeneralConfig from "./components/GeneralConfig";
import ModelConfig from "./components/ModelConfig";
import ProxyConfig from "./components/ProxyConfig";
import AgentConfig from "./components/AgentConfig";
import ExternalAgentConfig from "./components/ExternalAgentConfig";
import { createSettingSearchParams, resolveSettingTab, type SettingTabKey } from "./settingNavigation";

interface NavItem {
  key: SettingTabKey;
  labelKey: string;
  hintKey: string;
  icon: LucideIcon;
  tone: Tone;
}

const NAV: NavItem[] = [
  { key: "general", labelKey: "setting:nav.general.label", hintKey: "setting:nav.general.hint", icon: SlidersHorizontal, tone: "neutral" },
  { key: "proxy", labelKey: "setting:nav.proxy.label", hintKey: "setting:nav.proxy.hint", icon: Globe, tone: "blue" },
  { key: "model", labelKey: "setting:nav.model.label", hintKey: "setting:nav.model.hint", icon: Cpu, tone: "violet" },
  { key: "agent", labelKey: "setting:nav.agent.label", hintKey: "setting:nav.agent.hint", icon: Bot, tone: "teal" },
  { key: "external", labelKey: "setting:nav.external.label", hintKey: "setting:nav.external.hint", icon: Plug, tone: "green" },
];

const contentVariants = {
  initial: (dir: number) => ({ opacity: 0, y: dir * 10, filter: "blur(2px)" }),
  animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.28, ease: PAGE_EASE } },
  exit: (dir: number) => ({ opacity: 0, y: dir * -6, filter: "blur(2px)", transition: { duration: 0.12, ease: PAGE_EASE } }),
};

/**
 * Settings: the sections in a rail at the left (a row of tabs on a narrow window), the open one at the right,
 * scrolling on its own under its heading so the rail stays in place.
 */
const Setting: React.FC = () => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveSettingTab(searchParams.get("tab"));
  const previousTabRef = useRef<SettingTabKey>(tab);
  const directionRef = useRef(0);
  const current = NAV.find((item) => item.key === tab)!;

  if (previousTabRef.current !== tab) {
    const oldIdx = NAV.findIndex((item) => item.key === previousTabRef.current);
    const newIdx = NAV.findIndex((item) => item.key === tab);
    directionRef.current = newIdx > oldIdx ? 1 : -1;
    previousTabRef.current = tab;
  }

  const handleTabChange = useCallback((newTab: SettingTabKey) => {
    setSearchParams(createSettingSearchParams(searchParams, newTab), { replace: true });
  }, [searchParams, setSearchParams]);

  const scrollRootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  const checkScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScroll = scrollHeight - clientHeight;
    setShowTopFade(scrollTop > 1);
    setShowBottomFade(maxScroll > 0 && scrollTop < maxScroll - 1);
  }, []);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const vp = root.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!vp) return;
    viewportRef.current = vp;
    vp.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(vp);
    if (vp.firstElementChild) ro.observe(vp.firstElementChild);
    checkScroll();
    return () => {
      vp.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  // Each section starts at its top.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTop = 0;
    checkScroll();
  }, [tab, checkScroll]);

  const appVersion = import.meta.env.VITE_APP_VERSION || "-";

  return (
    // The page fits the window, so the rail stays while the section scrolls.
    // 120px = AppTitleBar (40) + spacer (40) + outer wrapper pt-10 (40); 40px at the bottom clears the navigation.
    <div className="mx-auto flex h-[calc(100dvh-120px)] max-w-6xl flex-col px-4 pb-[40px] sm:px-8" data-testid="settings-page">
      <PageHeader className="mb-6 shrink-0" eyebrow={t("setting:eyebrow")} title={t("setting:title")} description={t("setting:description")} />

      <div className="grid min-h-0 flex-1 grid-cols-[232px_minmax(0,1fr)] gap-8 max-md:grid-cols-1 max-md:gap-4">
        <nav aria-label={t("setting:title")} className="isolate flex flex-col gap-0.5 max-md:-mx-1 max-md:flex-row max-md:overflow-x-auto max-md:px-1 max-md:pb-1">
          {NAV.map((item, index) => {
            const active = item.key === tab;
            return (
              <motion.button
                key={item.key}
                type="button"
                onClick={() => handleTabChange(item.key)}
                aria-current={active ? "page" : undefined}
                data-testid={`setting-tab-${item.key}`}
                initial={reduceMotion ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.45, delay: 0.06 + index * 0.04, ease: PAGE_EASE }}
                className={cn(
                  "group relative flex items-center gap-3 rounded-smooth-xl px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                  "max-md:min-w-[168px] max-md:shrink-0",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && (
                  <SmoothCorners asChild radius={14} smoothing={0.72}>
                    <motion.span layoutId="setting-nav-indicator" aria-hidden
                      className="absolute inset-0 border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_16px_-10px_rgb(0_0_0/0.18)] dark:shadow-none"
                      transition={reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.38, bounce: 0.12 }} />
                  </SmoothCorners>
                )}
                {!active && <span aria-hidden className="absolute inset-0 rounded-smooth-xl bg-foreground/[0.04] opacity-0 transition-opacity group-hover:opacity-100" />}
                <ToneIcon icon={item.icon} tone={item.tone} size={30} solid={active} className="relative transition-[background,color,box-shadow] duration-300" />
                <div className="relative min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium leading-5">{t(item.labelKey)}</div>
                  <div className={cn("truncate text-[11.5px] leading-4", active ? "text-muted-foreground" : "text-muted-foreground/80")}>{t(item.hintKey)}</div>
                </div>
              </motion.button>
            );
          })}
          <div className="mt-auto hidden px-2.5 pt-6 text-[11px] text-muted-foreground md:block">
            <Link to="/about" className="font-mono transition-colors hover:text-foreground" data-testid="settings-version">FusionKit v{appVersion}</Link>
          </div>
        </nav>

        <div ref={scrollRootRef} className="relative min-h-0 min-w-0">
          <ScrollArea className="h-full" viewportProps={{ className: "[&>div]:!block" }}>
            <AnimatePresence mode="wait" custom={directionRef.current} initial={false}>
              <motion.div
                key={tab}
                custom={directionRef.current}
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                onAnimationStart={(def) => { if (def === "animate") checkScroll(); }}
                className="pb-6 pr-3 pl-px"
              >
                <div className="mb-6 flex items-center gap-3.5" data-testid="settings-section-header">
                  <ToneIcon icon={current.icon} tone={current.tone} size={44} solid />
                  <div className="min-w-0">
                    <h2 className="text-[20px] font-semibold leading-7 tracking-tight">{t(current.labelKey)}</h2>
                    <p className="text-[13px] leading-5 text-muted-foreground">{t(`setting:nav.${current.key}.about`)}</p>
                  </div>
                </div>
                {tab === "general" && <GeneralConfig />}
                {tab === "proxy" && <ProxyConfig />}
                {tab === "model" && <ModelConfig />}
                {tab === "agent" && <AgentConfig />}
                {tab === "external" && <ExternalAgentConfig />}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>

          <AnimatePresence>
            {showTopFade && (
              <motion.div key="top-fade" aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-8 bg-gradient-to-b from-background to-transparent"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showBottomFade && (
              <motion.div key="bottom-fade" aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-10 bg-gradient-to-t from-background to-transparent"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default Setting;
