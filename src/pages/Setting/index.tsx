import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { Settings as SettingsIcon, Globe, Cpu, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import GeneralConfig from "./components/GeneralConfig";
import ModelConfig from "./components/ModelConfig";
import ProxyConfig from "./components/ProxyConfig";

type TabKey = "general" | "proxy" | "model";

interface NavItem {
  key: TabKey;
  labelKey: string;
  hintKey: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { key: "general", labelKey: "setting:nav.general.label", hintKey: "setting:nav.general.hint", icon: SettingsIcon },
  { key: "proxy",   labelKey: "setting:nav.proxy.label",   hintKey: "setting:nav.proxy.hint",   icon: Globe },
  { key: "model",   labelKey: "setting:nav.model.label",   hintKey: "setting:nav.model.hint",   icon: Cpu },
];

const EASE_OUT_QUAD = [0.25, 0.46, 0.45, 0.94] as const;

const contentVariants = {
  initial: (dir: number) => ({ opacity: 0, y: dir * 8 }),
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: EASE_OUT_QUAD },
  },
  exit: (dir: number) => ({
    opacity: 0,
    y: dir * -4,
    transition: { duration: 0.1, ease: EASE_OUT_QUAD },
  }),
};

const Setting: React.FC = () => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("general");
  const [direction, setDirection] = useState(0);

  const handleTabChange = useCallback((newTab: TabKey) => {
    const oldIdx = NAV.findIndex((n) => n.key === tab);
    const newIdx = NAV.findIndex((n) => n.key === newTab);
    setDirection(newIdx > oldIdx ? 1 : -1);
    setTab(newTab);
  }, [tab]);

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
    const vp = root.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (!vp) return;
    viewportRef.current = vp;
    vp.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(vp);
    checkScroll();
    return () => {
      vp.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  // Reset scroll to top when switching tabs and re-evaluate fades.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTop = 0;
    checkScroll();
  }, [tab, checkScroll]);

  return (
    // Constrain the page to the visible area so the outer ScrollArea doesn't
    // scroll the header + sidebar with the content.
    // 120px = AppTitleBar (40) + spacer (40) + outer wrapper pt-10 (40).
    // 40px bottom padding clears the floating BottomNavigation.
    <div className="h-[calc(100dvh-120px)] flex flex-col px-4 sm:px-8 pb-[40px] max-w-5xl mx-auto">
      {/* Page header (fixed, does not scroll) */}
      <div className="mb-5 shrink-0">
        <div className="text-2xl font-semibold tracking-tight">
          {t("setting:title")}
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          {t("setting:description")}
        </div>
      </div>

      {/* Body: SubNav rail (fixed) + scrollable panel */}
      <div className="grid grid-cols-[200px_1fr] gap-5 flex-1 min-h-0 max-md:grid-cols-1 max-md:gap-3">
        {/* SubNav rail */}
        <nav className="flex flex-col gap-1 max-md:flex-row max-md:overflow-x-auto max-md:shrink-0 isolate">
          {NAV.map((item) => {
            const active = item.key === tab;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => handleTabChange(item.key)}
                className={cn(
                  "group relative flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer",
                  "max-md:shrink-0 max-md:min-w-[160px]",
                  active
                    ? "z-0 text-foreground"
                    : "z-[1] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {active && (
                  <motion.div
                    layoutId="setting-nav-indicator"
                    className="absolute inset-0 rounded-lg bg-accent border border-foreground/15"
                    transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
                  />
                )}
                <Icon className="relative h-[15px] w-[15px] shrink-0" />
                <div className="relative flex-1 min-w-0">
                  <div className="text-[13px] font-medium leading-tight">
                    {t(item.labelKey)}
                  </div>
                  <div
                    className={cn(
                      "text-[11px] mt-0.5 truncate",
                      active ? "text-foreground/60" : "text-muted-foreground/80"
                    )}
                  >
                    {t(item.hintKey)}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Scrollable content panel with scroll-aware edge fade masks.
            Use shadcn ScrollArea so we get a single consistent custom scrollbar
            (Radix hides the native one inside its viewport, avoiding the double
            bar caused by the global ::-webkit-scrollbar rules in index.css). */}
        <div
          ref={scrollRootRef}
          className="relative min-w-0 min-h-0"
        >
          <ScrollArea className="h-full">
            <AnimatePresence mode="wait" custom={direction}>
              <motion.div
                key={tab}
                custom={direction}
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                onAnimationStart={(def) => {
                  if (def === "animate") checkScroll();
                }}
                className="flex flex-col gap-4 py-1 pr-3"
              >
                {tab === "general" && <GeneralConfig />}
                {tab === "proxy" && <ProxyConfig />}
                {tab === "model" && <ModelConfig />}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>

          <AnimatePresence>
            {showTopFade && (
              <motion.div
                key="top-fade"
                aria-hidden="true"
                className="pointer-events-none absolute left-0 right-0 top-0 z-[5] h-8 bg-gradient-to-b from-background to-transparent"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showBottomFade && (
              <motion.div
                key="bottom-fade"
                aria-hidden="true"
                className="pointer-events-none absolute left-0 right-0 bottom-0 z-[5] h-8 bg-gradient-to-t from-background to-transparent"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default Setting;
