"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useId,
  useCallback,
} from "react";
import {
  Code,
  Eye,
  AlertCircle,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  CodeBlock,
  type CodeBlockColorThemeName,
  type CodeBlockThemeConfig,
} from "@/components/qiuye-ui/code-block";
import type { PrismTheme } from "prism-react-renderer";
import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  AnimatePresence,
  useReducedMotion,
} from "motion/react";
import { Button } from "@/components/ui/button";

// ============================================
// Mermaid 动态导入与主题
// ============================================

type MermaidAPI = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidAPI> | null = null;

function loadMermaid(): Promise<MermaidAPI> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

const MERMAID_FONT_FAMILY =
  '"Inter", "Fira Code", "Monaco", "Menlo", "Ubuntu Mono", "Consolas", "source-code-pro", monospace';

interface MermaidThemePalette {
  background: string;
  text: string;
  mutedText: string;
  nodeFill: string;
  nodeStroke: string;
  clusterFill: string;
  clusterStroke: string;
  edgeLabelFill: string;
  edgeLabelStroke: string;
  noteFill: string;
  noteStroke: string;
  line: string;
  grid: string;
  pie: string[];
}

function getMermaidPalette(
  colorTheme: CodeBlockColorThemeName | undefined,
  isDark: boolean,
): MermaidThemePalette {
  const isQiuvision = colorTheme === "qiuvision";

  if (isQiuvision) {
    return isDark
      ? {
          background: "#1A1A1A",
          text: "#ECECEC",
          mutedText: "#B8B1A2",
          nodeFill: "#25231E",
          nodeStroke: "#D6C8A6",
          clusterFill: "#1F1E1A",
          clusterStroke: "rgba(214, 200, 166, 0.42)",
          edgeLabelFill: "#1A1A1A",
          edgeLabelStroke: "rgba(214, 200, 166, 0.28)",
          noteFill: "#2B271E",
          noteStroke: "#D6C8A6",
          line: "#C9B889",
          grid: "rgba(214, 200, 166, 0.18)",
          pie: [
            "#D6C8A6",
            "#BFA66F",
            "#9D7A43",
            "#E7DCC3",
            "#8E714A",
            "#CBB98D",
          ],
        }
      : {
          background: "#FAFAFA",
          text: "#1F1F1F",
          mutedText: "#6F6659",
          nodeFill: "#FBF8F0",
          nodeStroke: "#A07A44",
          clusterFill: "#F7F2E8",
          clusterStroke: "rgba(160, 122, 68, 0.36)",
          edgeLabelFill: "#FAFAFA",
          edgeLabelStroke: "rgba(160, 122, 68, 0.24)",
          noteFill: "#F6EEDC",
          noteStroke: "#A07A44",
          line: "#9B7847",
          grid: "rgba(160, 122, 68, 0.16)",
          pie: [
            "#A07A44",
            "#C2A36E",
            "#E4D3AD",
            "#765932",
            "#B78D4C",
            "#F1E7D1",
          ],
        };
  }

  return {
    background: isDark ? "#09090B" : "#FFFFFF",
    text: isDark ? "#FAFAFA" : "#18181B",
    mutedText: isDark ? "#A1A1AA" : "#71717A",
    nodeFill: isDark ? "#18181B" : "#F4F4F5",
    nodeStroke: isDark ? "#52525B" : "#A1A1AA",
    clusterFill: isDark ? "#111113" : "#FAFAFA",
    clusterStroke: isDark ? "#3F3F46" : "#D4D4D8",
    edgeLabelFill: isDark ? "#09090B" : "#FFFFFF",
    edgeLabelStroke: isDark ? "#27272A" : "#E4E4E7",
    noteFill: isDark ? "#18181B" : "#F4F4F5",
    noteStroke: isDark ? "#52525B" : "#A1A1AA",
    line: isDark ? "#A1A1AA" : "#71717A",
    grid: isDark ? "rgba(161, 161, 170, 0.18)" : "rgba(113, 113, 122, 0.16)",
    pie: isDark
      ? ["#FAFAFA", "#D4D4D8", "#A1A1AA", "#71717A", "#52525B", "#3F3F46"]
      : ["#18181B", "#3F3F46", "#71717A", "#A1A1AA", "#D4D4D8", "#E4E4E7"],
  };
}

function getMermaidThemeVariables(palette: MermaidThemePalette, isDark: boolean) {
  const [pie1, pie2, pie3, pie4, pie5, pie6] = palette.pie;

  return {
    darkMode: isDark,
    background: palette.background,
    primaryColor: palette.nodeFill,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.nodeStroke,
    lineColor: palette.line,
    secondaryColor: palette.clusterFill,
    tertiaryColor: palette.noteFill,
    mainBkg: palette.nodeFill,
    secondBkg: palette.clusterFill,
    tertiaryBkg: palette.noteFill,
    nodeBorder: palette.nodeStroke,
    clusterBkg: palette.clusterFill,
    clusterBorder: palette.clusterStroke,
    edgeLabelBackground: palette.edgeLabelFill,
    textColor: palette.text,
    nodeTextColor: palette.text,
    titleColor: palette.text,
    noteBkgColor: palette.noteFill,
    noteTextColor: palette.text,
    noteBorderColor: palette.noteStroke,
    actorBkg: palette.nodeFill,
    actorBorder: palette.nodeStroke,
    actorTextColor: palette.text,
    signalColor: palette.line,
    signalTextColor: palette.text,
    labelBoxBkgColor: palette.edgeLabelFill,
    labelBoxBorderColor: palette.edgeLabelStroke,
    labelTextColor: palette.text,
    loopTextColor: palette.text,
    activationBkgColor: palette.clusterFill,
    activationBorderColor: palette.nodeStroke,
    sequenceNumberColor: palette.background,
    sectionBkgColor: palette.nodeFill,
    altSectionBkgColor: palette.clusterFill,
    gridColor: palette.grid,
    taskBorderColor: palette.nodeStroke,
    taskBkgColor: palette.nodeFill,
    activeTaskBkgColor: palette.clusterFill,
    activeTaskBorderColor: palette.nodeStroke,
    doneTaskBkgColor: palette.clusterFill,
    doneTaskBorderColor: palette.clusterStroke,
    critBorderColor: palette.nodeStroke,
    critBkgColor: palette.noteFill,
    todayLineColor: palette.line,
    pie1,
    pie2,
    pie3,
    pie4,
    pie5,
    pie6,
    pieOuterStrokeColor: palette.background,
    pieTitleTextSize: "18px",
    pieSectionTextColor: palette.text,
    pieLegendTextColor: palette.text,
    pieStrokeColor: palette.background,
  };
}

function getMermaidThemeCss(palette: MermaidThemePalette): string {
  return `
    .node rect,
    .node circle,
    .node ellipse,
    .node polygon,
    .node path,
    .classGroup rect,
    .classGroup line,
    .stateGroup rect,
    .note rect,
    rect.actor {
      rx: 10px;
      ry: 10px;
    }

    .node rect,
    .node circle,
    .node ellipse,
    .node polygon,
    .node path,
    .classGroup rect,
    .stateGroup rect,
    .note rect,
    rect.actor {
      fill: ${palette.nodeFill};
      stroke: ${palette.nodeStroke};
      stroke-width: 1.15px;
    }

    .cluster rect {
      fill: ${palette.clusterFill};
      stroke: ${palette.clusterStroke};
      stroke-width: 1.05px;
    }

    .edgeLabel rect,
    .edgeLabel .labelBkg,
    .label-container {
      fill: ${palette.edgeLabelFill};
      stroke: ${palette.edgeLabelStroke};
      rx: 8px;
      ry: 8px;
    }

    .flowchart-link,
    .edge-thickness-normal,
    .edge-thickness-thick,
    .messageLine0,
    .messageLine1 {
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .flowchart-link,
    .edgePath .path,
    path.relation,
    .messageLine0,
    .messageLine1 {
      stroke: ${palette.line};
    }

    marker path,
    .arrowheadPath {
      fill: ${palette.line};
      stroke: ${palette.line};
    }

    text,
    .label,
    .nodeLabel,
    .edgeLabel,
    .messageText,
    text.actor,
    .titleText {
      fill: ${palette.text};
      color: ${palette.text};
    }

    .edgeLabel {
      color: ${palette.text};
    }

    .cluster text,
    .noteText,
    .loopText,
    .labelText {
      fill: ${palette.mutedText};
      color: ${palette.mutedText};
    }
  `;
}

// ============================================
// MermaidBlock 组件
// ============================================

export interface MermaidBlockProps {
  children: string;
  stickyLineNumbers?: boolean;
  colorTheme?: CodeBlockColorThemeName;
  customTheme?: CodeBlockThemeConfig | PrismTheme;
}

export function MermaidBlock({
  children,
  stickyLineNumbers = true,
  colorTheme,
  customTheme,
}: MermaidBlockProps) {
  const code = children.trim();
  const [showPreview, setShowPreview] = useState(true);
  const [svgContent, setSvgContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState<boolean | null>(null);
  const { resolvedTheme } = useTheme();
  const isDark = !mounted || resolvedTheme !== "light";
  const containerRef = useRef<HTMLDivElement>(null);
  const contentMeasureRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId();
  const mermaidIdBase = `mermaid-${uniqueId.replace(/:/g, "-")}`;
  const renderCountRef = useRef(0);
  const [contentHeight, setContentHeight] = useState<number | "auto">("auto");

  const [isFullscreen, setIsFullscreen] = useState(false);
  const motionX = useMotionValue(0);
  const motionY = useMotionValue(0);
  const motionScale = useMotionValue(1);
  const prefersReducedMotion = useReducedMotion();
  const [scaleDisplay, setScaleDisplay] = useState(100);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const positionStartRef = useRef({ x: 0, y: 0 });
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const pinchStartDistanceRef = useRef(0);
  const pinchStartScaleRef = useRef(1);

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  const SCALE_STEP = 0.25;
  const fullscreenEase: [number, number, number, number] = [0.22, 1, 0.36, 1];
  const fullscreenOverlayTransition = prefersReducedMotion
    ? { duration: 0.14, ease: "linear" as const }
    : { duration: 0.28, ease: fullscreenEase };
  const fullscreenPanelTransition = prefersReducedMotion
    ? { duration: 0.16, ease: "linear" as const }
    : { duration: 0.36, ease: fullscreenEase };
  const fullscreenOverlayExitTransition = prefersReducedMotion
    ? { duration: 0.12, ease: "linear" as const }
    : { duration: 0.18, ease: fullscreenEase };
  const fullscreenPanelExitTransition = prefersReducedMotion
    ? { duration: 0.12, ease: "linear" as const }
    : { duration: 0.2, ease: fullscreenEase };
  const contentHeightTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.42, ease: fullscreenEase };

  useMotionValueEvent(motionScale, "change", (latest) => {
    const displayValue = Math.round(latest * 100);
    setScaleDisplay((prev) =>
      Math.abs(prev - displayValue) >= 1 ? displayValue : prev,
    );
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const element = contentMeasureRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    let frameId = 0;
    const updateHeight = () => {
      const nextHeight = element.getBoundingClientRect().height;
      if (nextHeight <= 0) return;

      setContentHeight((prevHeight) => {
        if (
          typeof prevHeight === "number" &&
          Math.abs(prevHeight - nextHeight) < 0.5
        ) {
          return prevHeight;
        }

        return nextHeight;
      });
    };

    updateHeight();

    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateHeight);
    });
    resizeObserver.observe(element);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;

    const hoverFineQuery = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    );
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

    const updateDeviceMode = () => {
      const hasTouchInput = navigator.maxTouchPoints > 0;
      setIsTouchDevice(
        coarsePointerQuery.matches ||
          (hasTouchInput && !hoverFineQuery.matches),
      );
    };

    updateDeviceMode();
    hoverFineQuery.addEventListener("change", updateDeviceMode);
    coarsePointerQuery.addEventListener("change", updateDeviceMode);

    return () => {
      hoverFineQuery.removeEventListener("change", updateDeviceMode);
      coarsePointerQuery.removeEventListener("change", updateDeviceMode);
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !showPreview) return;

    let cancelled = false;

    const initAndRender = async () => {
      try {
        setError(null);

        const mermaid = await loadMermaid();
        if (cancelled) return;

        const mermaidPalette = getMermaidPalette(colorTheme, isDark);

        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "loose",
          htmlLabels: true,
          fontFamily: MERMAID_FONT_FAMILY,
          flowchart: {
            curve: "natural",
          },
          themeVariables: getMermaidThemeVariables(mermaidPalette, isDark),
          themeCSS: getMermaidThemeCss(mermaidPalette),
        });

        const isValid = await mermaid.parse(code);
        if (cancelled) return;

        if (!isValid) {
          setError("Mermaid 语法验证失败");
          return;
        }

        renderCountRef.current += 1;
        const mermaidId = `${mermaidIdBase}-${renderCountRef.current}`;
        const { svg } = await mermaid.render(mermaidId, code);
        if (cancelled) return;

        setSvgContent(svg);
      } catch (err) {
        if (cancelled) return;
        console.error("Mermaid render error:", err);
        setError(err instanceof Error ? err.message : "Mermaid 渲染失败");
      }
    };

    initAndRender();

    return () => {
      cancelled = true;
    };
  }, [
    mounted,
    code,
    showPreview,
    mermaidIdBase,
    colorTheme,
    isDark,
  ]);

  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        isDraggingRef.current = false;
        setIsFullscreen(false);
      }
    };

    const handleGlobalWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    };

    const handleGestureStart = (e: Event) => {
      e.preventDefault();
    };

    const handleGestureChange = (e: Event) => {
      e.preventDefault();
      const gestureEvent = e as Event & { scale?: number };
      if (gestureEvent.scale !== undefined) {
        const newScale = Math.min(
          Math.max(gestureEvent.scale, MIN_SCALE),
          MAX_SCALE,
        );
        motionScale.set(newScale);
      }
    };

    const handleGestureEnd = (e: Event) => {
      e.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("wheel", handleGlobalWheel, { passive: false });
    document.addEventListener("gesturestart", handleGestureStart);
    document.addEventListener("gesturechange", handleGestureChange);
    document.addEventListener("gestureend", handleGestureEnd);

    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("wheel", handleGlobalWheel);
      document.removeEventListener("gesturestart", handleGestureStart);
      document.removeEventListener("gesturechange", handleGestureChange);
      document.removeEventListener("gestureend", handleGestureEnd);
      document.body.style.overflow = "";
    };
  }, [isFullscreen, motionScale, motionX, motionY]);

  const resetTransform = useCallback(() => {
    motionScale.set(1);
    motionX.set(0);
    motionY.set(0);
    setScaleDisplay(100);
  }, [motionScale, motionX, motionY]);

  const handleZoomIn = useCallback(() => {
    const newScale = Math.min(motionScale.get() + SCALE_STEP, MAX_SCALE);
    motionScale.set(newScale);
  }, [motionScale]);

  const handleZoomOut = useCallback(() => {
    const newScale = Math.max(motionScale.get() - SCALE_STEP, MIN_SCALE);
    motionScale.set(newScale);
  }, [motionScale]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!isFullscreen) return;
      e.preventDefault();

      const currentScale = motionScale.get();

      if (e.ctrlKey) {
        const zoomFactor = 1 - e.deltaY * 0.01;
        const newScale = Math.min(
          Math.max(currentScale * zoomFactor, MIN_SCALE),
          MAX_SCALE,
        );
        motionScale.set(newScale);
      } else {
        const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
        const newScale = Math.min(
          Math.max(currentScale + delta, MIN_SCALE),
          MAX_SCALE,
        );
        motionScale.set(newScale);
      }
    },
    [isFullscreen, motionScale],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!isFullscreen) return;
      e.preventDefault();
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      positionStartRef.current = { x: motionX.get(), y: motionY.get() };
    },
    [isFullscreen, motionX, motionY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingRef.current || !isFullscreen) return;

      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      motionX.set(positionStartRef.current.x + deltaX);
      motionY.set(positionStartRef.current.y + deltaY);
    },
    [isFullscreen, motionX, motionY],
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const getTouchDistance = useCallback((touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isFullscreen) return;

      if (e.touches.length === 1) {
        isDraggingRef.current = true;
        dragStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
        positionStartRef.current = { x: motionX.get(), y: motionY.get() };
      } else if (e.touches.length === 2) {
        isDraggingRef.current = false;
        pinchStartDistanceRef.current = getTouchDistance(e.touches);
        pinchStartScaleRef.current = motionScale.get();
      }
    },
    [isFullscreen, motionX, motionY, motionScale, getTouchDistance],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isFullscreen) return;

      if (e.touches.length === 1 && isDraggingRef.current) {
        const deltaX = e.touches[0].clientX - dragStartRef.current.x;
        const deltaY = e.touches[0].clientY - dragStartRef.current.y;

        motionX.set(positionStartRef.current.x + deltaX);
        motionY.set(positionStartRef.current.y + deltaY);
      } else if (e.touches.length === 2) {
        const currentDistance = getTouchDistance(e.touches);
        const scaleRatio = currentDistance / pinchStartDistanceRef.current;
        const newScale = Math.min(
          Math.max(pinchStartScaleRef.current * scaleRatio, MIN_SCALE),
          MAX_SCALE,
        );

        motionScale.set(newScale);
      }
    },
    [isFullscreen, motionX, motionY, motionScale, getTouchDistance],
  );

  const handleTouchEnd = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const enterFullscreen = useCallback(() => {
    motionScale.set(1);
    motionX.set(0);
    motionY.set(0);
    setScaleDisplay(100);
    setIsFullscreen(true);
  }, [motionScale, motionX, motionY]);

  const exitFullscreen = useCallback(() => {
    isDraggingRef.current = false;
    setIsFullscreen(false);
  }, []);

  if (!mounted) {
    return (
      <div className="mermaid-block rounded-lg bg-muted/20 p-4">
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          加载中...
        </div>
      </div>
    );
  }

  const renderSvgContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-6 w-6" />
          <span className="text-sm">{error}</span>
        </div>
      );
    }

    if (!svgContent) {
      return (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-sm">
          渲染中...
        </div>
      );
    }

    return (
      <div
        className="mermaid-svg-container pointer-events-none"
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />
    );
  };

  const renderFullscreenSvgContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-6 w-6" />
          <span className="text-sm">{error}</span>
        </div>
      );
    }

    if (!svgContent) {
      return (
        <div className="flex items-center justify-center py-4 text-muted-foreground text-sm">
          渲染中...
        </div>
      );
    }

    return (
      <motion.div
        ref={svgContainerRef}
        className="mermaid-svg-container pointer-events-none cursor-grab"
        style={{
          x: motionX,
          y: motionY,
          scale: motionScale,
        }}
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />
    );
  };

  const fullscreenToolbarSurfaceClass =
    "pointer-events-auto rounded-2xl border border-border/40 bg-background/72 shadow-lg shadow-black/5 backdrop-blur-md";
  const showFullscreenDesktopHint = isTouchDevice === false;
  const showFullscreenTouchExitButton = isTouchDevice === true;

  const fullscreenToolbarInfo = (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-muted-foreground">
        Mermaid 图表预览
      </span>
      <span className="text-xs text-muted-foreground/60">{scaleDisplay}%</span>
    </div>
  );

  const fullscreenToolbarControls = (
    <div className="flex items-center gap-1">
      <button
        onClick={handleZoomOut}
        disabled={scaleDisplay <= MIN_SCALE * 100}
        className="p-2 rounded-md text-muted-foreground cursor-pointer hover:text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title="缩小"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        onClick={handleZoomIn}
        disabled={scaleDisplay >= MAX_SCALE * 100}
        className="p-2 rounded-md text-muted-foreground cursor-pointer hover:text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title="放大"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <button
        onClick={resetTransform}
        className="p-2 rounded-md text-muted-foreground cursor-pointer hover:text-foreground hover:bg-muted/50 transition-colors"
        title="重置视图"
      >
        <RotateCcw className="h-4 w-4" />
      </button>
      <div className="w-px h-4 bg-border/50 mx-1" />
      <button
        onClick={exitFullscreen}
        className="p-2 rounded-md text-muted-foreground cursor-pointer hover:text-foreground hover:bg-muted/50 transition-colors"
        title="退出预览 (ESC)"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <>
      <div className="mermaid-block rounded-lg overflow-hidden">
        <div className="mermaid-toolbar flex items-center justify-between pl-4 pr-2 py-2 bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Mermaid
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPreview(false)}
              className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                !showPreview
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              title="查看源码"
            >
              {!showPreview && (
                <motion.span
                  layoutId={`${mermaidIdBase}-tab-bg`}
                  className="absolute inset-0 bg-primary/10 rounded-md"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                />
              )}
              <Code className="relative h-3.5 w-3.5" />
              <span className="relative">代码</span>
            </button>
            <button
              onClick={() => setShowPreview(true)}
              className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                showPreview
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              title="查看预览"
            >
              {showPreview && (
                <motion.span
                  layoutId={`${mermaidIdBase}-tab-bg`}
                  className="absolute inset-0 bg-primary/10 rounded-md"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                />
              )}
              <Eye className="relative h-3.5 w-3.5" />
              <span className="relative">预览</span>
            </button>
          </div>
        </div>

        <motion.div
          className="mermaid-content group/mermaid relative overflow-hidden"
          animate={{ height: contentHeight }}
          transition={contentHeightTransition}
        >
          <div ref={contentMeasureRef} className="relative">
            <AnimatePresence mode="popLayout" initial={false}>
              {showPreview ? (
                <motion.div
                  key="preview"
                  initial={{ opacity: 0, x: "50%" }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: "50%" }}
                  transition={{ duration: 0.5, type: "spring", bounce: 0 }}
                  ref={containerRef}
                  className="mermaid-preview relative flex justify-center p-6 min-h-[120px]"
                >
                  {renderSvgContent()}
                  {svgContent && !error && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={enterFullscreen}
                      className="absolute top-2 right-2 size-8 md:opacity-0 md:group-hover/mermaid:opacity-100"
                      title="全屏查看"
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="code"
                  initial={{ opacity: 0, x: "-50%" }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: "-50%" }}
                  transition={{ duration: 0.5, type: "spring", bounce: 0 }}
                >
                  <CodeBlock
                    language="mermaid"
                    isDark={isDark}
                    stickyLineNumbers={stickyLineNumbers}
                    colorTheme={colorTheme}
                    customTheme={customTheme}
                  >
                    {code}
                  </CodeBlock>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      <AnimatePresence initial={false} onExitComplete={resetTransform}>
        {isFullscreen && (
          <motion.div
            key="mermaid-fullscreen"
            className="mermaid-fullscreen-overlay fixed inset-0 z-[9999] overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: fullscreenOverlayTransition }}
            exit={{ opacity: 0, transition: fullscreenOverlayExitTransition }}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid 图表全屏预览"
          >
            <motion.div
              className="absolute inset-0 bg-background/95 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: fullscreenOverlayTransition }}
              exit={{ opacity: 0, transition: fullscreenOverlayExitTransition }}
            />

            <motion.div
              className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(124,167,255,0.08),transparent_45%),radial-gradient(circle_at_bottom,rgba(214,200,166,0.08),transparent_42%)]"
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                transition: {
                  ...fullscreenOverlayTransition,
                  delay: prefersReducedMotion ? 0 : 0.03,
                },
              }}
              exit={{ opacity: 0, transition: fullscreenOverlayExitTransition }}
            />

            <div className="pointer-events-none absolute inset-x-0 top-[4.5rem] z-[10000] px-3 sm:px-4">
              <motion.div
                className={`flex items-center justify-between px-4 py-3 md:hidden ${fullscreenToolbarSurfaceClass}`}
                initial={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : -18,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(10px)",
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: {
                    ...fullscreenPanelTransition,
                    delay: prefersReducedMotion ? 0 : 0.04,
                  },
                }}
                exit={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : -12,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(8px)",
                  transition: fullscreenPanelExitTransition,
                }}
              >
                {fullscreenToolbarInfo}
                {fullscreenToolbarControls}
              </motion.div>

              <div className="hidden md:flex items-start justify-between gap-4">
                <motion.div
                  className={`w-fit px-4 py-3 ${fullscreenToolbarSurfaceClass}`}
                  initial={{
                    opacity: 0,
                    x: prefersReducedMotion ? 0 : -16,
                    y: prefersReducedMotion ? 0 : -18,
                    filter: prefersReducedMotion ? "blur(0px)" : "blur(10px)",
                  }}
                  animate={{
                    opacity: 1,
                    x: 0,
                    y: 0,
                    filter: "blur(0px)",
                    transition: {
                      ...fullscreenPanelTransition,
                      delay: prefersReducedMotion ? 0 : 0.04,
                    },
                  }}
                  exit={{
                    opacity: 0,
                    x: prefersReducedMotion ? 0 : -10,
                    y: prefersReducedMotion ? 0 : -12,
                    filter: prefersReducedMotion ? "blur(0px)" : "blur(8px)",
                    transition: fullscreenPanelExitTransition,
                  }}
                >
                  {fullscreenToolbarInfo}
                </motion.div>

                <motion.div
                  className={`w-fit px-3 py-2 ${fullscreenToolbarSurfaceClass}`}
                  initial={{
                    opacity: 0,
                    x: prefersReducedMotion ? 0 : 16,
                    y: prefersReducedMotion ? 0 : -18,
                    filter: prefersReducedMotion ? "blur(0px)" : "blur(10px)",
                  }}
                  animate={{
                    opacity: 1,
                    x: 0,
                    y: 0,
                    filter: "blur(0px)",
                    transition: {
                      ...fullscreenPanelTransition,
                      delay: prefersReducedMotion ? 0 : 0.08,
                    },
                  }}
                  exit={{
                    opacity: 0,
                    x: prefersReducedMotion ? 0 : 10,
                    y: prefersReducedMotion ? 0 : -12,
                    filter: prefersReducedMotion ? "blur(0px)" : "blur(8px)",
                    transition: fullscreenPanelExitTransition,
                  }}
                >
                  {fullscreenToolbarControls}
                </motion.div>
              </div>
            </div>

            <div
              className="absolute top-0 bottom-0 left-0 w-screen overflow-hidden px-4 pt-20 pb-20 sm:px-6 sm:pb-24"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              <motion.div
                className="flex h-full w-full items-center justify-center"
                initial={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 20,
                  scale: prefersReducedMotion ? 1 : 0.985,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(14px)",
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  filter: "blur(0px)",
                  transition: {
                    ...fullscreenPanelTransition,
                    delay: prefersReducedMotion ? 0 : 0.06,
                  },
                }}
                exit={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 16,
                  scale: prefersReducedMotion ? 1 : 0.99,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(10px)",
                  transition: fullscreenPanelExitTransition,
                }}
              >
                {renderFullscreenSvgContent()}
              </motion.div>
            </div>

            {showFullscreenDesktopHint && (
              <motion.div
                className="absolute bottom-4 left-4 flex items-center gap-4 rounded-full border border-border/35 bg-muted/45 px-4 py-2 text-xs text-muted-foreground backdrop-blur-md"
                initial={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 14,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(8px)",
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: {
                    ...fullscreenPanelTransition,
                    delay: prefersReducedMotion ? 0 : 0.1,
                  },
                }}
                exit={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 10,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(6px)",
                  transition: fullscreenPanelExitTransition,
                }}
              >
                <span>滚轮缩放</span>
                <span className="w-px h-3 bg-border/50" />
                <span>拖拽移动</span>
                <span className="w-px h-3 bg-border/50" />
                <span>ESC 退出</span>
              </motion.div>
            )}

            {showFullscreenTouchExitButton && (
              <motion.div
                className="pointer-events-none absolute inset-x-0 bottom-8 z-[10000] flex justify-center px-4"
                initial={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 14,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(8px)",
                }}
                animate={{
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: {
                    ...fullscreenPanelTransition,
                    delay: prefersReducedMotion ? 0 : 0.1,
                  },
                }}
                exit={{
                  opacity: 0,
                  y: prefersReducedMotion ? 0 : 10,
                  filter: prefersReducedMotion ? "blur(0px)" : "blur(6px)",
                  transition: fullscreenPanelExitTransition,
                }}
              >
                <Button
                  type="button"
                  variant="outline"
                  onClick={exitFullscreen}
                  className="pointer-events-auto h-11 rounded-full border-border/40 bg-background/78 px-5 text-sm text-foreground shadow-lg shadow-black/5 backdrop-blur-md hover:bg-background/88"
                >
                  <X className="h-4 w-4" />
                  退出预览
                </Button>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
