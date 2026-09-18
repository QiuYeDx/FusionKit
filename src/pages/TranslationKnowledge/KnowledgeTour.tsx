import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Tour, type TourStep } from "@/components/qiuye-ui/tour";
import { Button } from "@/components/ui/button";

const TOUR_DONE_KEY = "translation-knowledge-tour-done";

export function useKnowledgeTour(ready: boolean) {
  const [tourOpen, updateTourOpen] = useState(false);
  const hasOpened = useRef(false);
  const setTourOpen = useCallback((open: boolean) => {
    if (open) hasOpened.current = true;
    updateTourOpen(open);
  }, []);

  useEffect(() => {
    if (!ready || tourOpen || hasOpened.current || localStorage.getItem(TOUR_DONE_KEY)) return;
    let timer: ReturnType<typeof setTimeout>;
    const openWhenVisible = () => {
      // Native preload and unrelated dialogs can outlive the library read.
      if (document.querySelector('.app-loading-wrap, #app-loading-style, [role="dialog"], [role="alertdialog"]')) {
        timer = setTimeout(openWhenVisible, 200);
        return;
      }
      setTourOpen(true);
    };
    timer = setTimeout(openWhenVisible, 400);
    return () => clearTimeout(timer);
  }, [ready, tourOpen, setTourOpen]);

  return { tourOpen, setTourOpen };
}

// Find the interactive tab, avoiding ClipPathTabs' duplicate decorative label.
const tabTarget = (view: "materials" | "review" | "plans") => () =>
  document.querySelector<HTMLElement>(
    `[data-testid="knowledge-views"] [role="tab"] [data-knowledge-tour="${view}"]`,
  )?.closest<HTMLElement>('[role="tab"]') ?? null;

export function KnowledgeTour({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("knowledge");
  const steps = useMemo<TourStep[]>(() => [
    {
      id: "collection",
      target: "#knowledge-tour-collection",
      title: t("tour.collection_title"),
      content: <div className="space-y-3">
        <p>{t("tour.collection_content")}</p>
        <p className="text-xs leading-5">{t("tour.collection_hint")}</p>
      </div>,
      placement: "right",
    },
    {
      id: "materials",
      target: tabTarget("materials"),
      title: t("tour.materials_title"),
      content: <div className="space-y-3">
        <p>{t("tour.materials_content")}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          <span>checkpoint</span><ArrowRight aria-hidden className="size-3.5 text-muted-foreground" /><span>{t("tour.term_example")}</span>
        </div>
        <p className="text-xs leading-5">{t("tour.materials_hint")}</p>
      </div>,
      placement: "bottom",
      align: "start",
    },
    {
      id: "review",
      target: tabTarget("review"),
      title: t("tour.review_title"),
      content: <div className="space-y-3">
        <p>{t("tour.review_content")}</p>
        <p className="text-xs leading-5">{t("tour.review_hint")}</p>
      </div>,
      placement: "bottom",
    },
    {
      id: "plans",
      target: tabTarget("plans"),
      title: t("tour.plans_title"),
      content: <div className="space-y-3">
        <p>{t("tour.plans_content")}</p>
        <p className="text-xs leading-5">{t("tour.plans_hint")}</p>
      </div>,
      placement: "bottom",
    },
    {
      id: "studio",
      target: "#knowledge-tour-studio",
      title: t("tour.studio_title"),
      content: <div className="space-y-3">
        <p>{t("tour.studio_content")}</p>
        <p className="text-xs leading-5">{t("tour.studio_hint")}</p>
      </div>,
      placement: "right",
    },
  ], [t]);
  const remember = () => localStorage.setItem(TOUR_DONE_KEY, "1");

  return <Tour
    steps={steps}
    open={open}
    onOpenChange={onOpenChange}
    onFinish={remember}
    onSkip={remember}
    popoverWidth={360}
    popoverClassName="knowledge-tour-popover"
    spotlightClassName="knowledge-tour-spotlight"
    renderFooter={({ skip, previous, next, isFirstStep, isLastStep }) => (
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button data-testid="knowledge-tour-skip" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={skip}>{t("tour.skip")}</Button>
        <div className="flex items-center gap-2">
          <Button data-testid="knowledge-tour-previous" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={previous} disabled={isFirstStep}><ChevronLeft className="size-3.5" />{t("tour.previous")}</Button>
          <Button data-testid="knowledge-tour-next" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={next}>{t(isLastStep ? "tour.finish" : "tour.next")}{!isLastStep && <ChevronRight className="size-3.5" />}</Button>
        </div>
      </div>
    )}
    maskClosable
    scrollIntoView
  />;
}
