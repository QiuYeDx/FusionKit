import { useRef, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { ArrowRight, AudioLines, BookOpenText, Check, Sparkles } from "lucide-react";
import MeshGradient, { type GradientPalette, type MeshGradientHandle } from "@/components/mesh-gradient/MeshGradient";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import useThemeStore from "@/store/useThemeStore";

const MotionLink = motion.create(Link);
const TILT_SPRING = { stiffness: 170, damping: 20, mass: 0.6 };
const EASE = [0.23, 1, 0.32, 1] as const;

export type FeaturedKind = "studio" | "knowledge";

/** Calm, airy colours in light mode; deep ones in dark mode. Colour 0 is the base. */
const PALETTES: Record<FeaturedKind, { light: GradientPalette; dark: GradientPalette }> = {
  studio: {
    light: ["#e9f6fa", "#7fd0f0", "#9be7d8", "#a9bdff", "#c9f1ff"],
    dark: ["#071419", "#0d5a73", "#0f6b62", "#26339a", "#0b3346"],
  },
  knowledge: {
    light: ["#f3effc", "#bba6ff", "#ffbdd6", "#9fb1ff", "#e6dbff"],
    dark: ["#120d1f", "#4a2c93", "#7a2f6f", "#2c3a9e", "#25174a"],
  },
};

/** A piece of the artwork at a depth: it floats towards the viewer and drifts against the tilt. */
function DepthLayer({ depth, x, y, className, style, children }: {
  depth: number; x: MotionValue<number>; y: MotionValue<number>; className?: string; style?: CSSProperties; children: ReactNode;
}) {
  const driftX = useTransform(x, [0, 1], [-depth * 0.22, depth * 0.22]);
  const driftY = useTransform(y, [0, 1], [-depth * 0.16, depth * 0.16]);
  return <motion.div className={`featured-layer ${className ?? ""}`} style={{ ...style, z: depth, x: driftX, y: driftY }}>{children}</motion.div>;
}

function Glass({ className, children }: { className?: string; children: ReactNode }) {
  return <SmoothCorners radius={14} smoothing={0.72} className={`featured-glass ${className ?? ""}`}>{children}</SmoothCorners>;
}

const WAVE = [6, 12, 20, 14, 26, 18, 30, 22, 12, 24, 34, 20, 14, 28, 18, 10, 22, 16, 8, 14, 24, 12];

function StudioArt({ x, y }: { x: MotionValue<number>; y: MotionValue<number> }) {
  const { t } = useTranslation();
  return <>
    <DepthLayer depth={14} x={x} y={y} className="featured-art-media">
      <Glass className="p-3">
        <div className="flex items-center gap-2 text-[10.5px] text-[var(--glass-muted)]">
          <AudioLines className="size-3.5 text-[var(--feature-ink)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono">live_0412.mp4</span>
          <span className="font-mono tabular-nums">00:12 / 03:20</span>
        </div>
        <div className="featured-wave mt-2.5">
          {WAVE.map((height, index) => <i key={index} style={{ height, opacity: index < 9 ? 0.95 : 0.4 }} />)}
          <b aria-hidden style={{ left: `${(9 / WAVE.length) * 100}%` }} />
        </div>
      </Glass>
    </DepthLayer>
    <DepthLayer depth={34} x={x} y={y} className="featured-art-cues">
      <Glass className="py-1.5">
        <div className="px-3 pt-1 pb-1.5 text-[10.5px] font-medium text-[var(--glass-muted)]">{t("tools:catalog.art_studio_cues")}</div>
        {[["00:08", "こんにちは、みなさん", "大家好"], ["00:12", "今日もいい天気ですね", "今天天气也很好呢"], ["00:17", "それでは始めましょう", "那我们开始吧"]].map(([time, source, target], index) =>
          <div key={time} className={`featured-cue ${index === 1 ? "is-active" : ""}`}>
            <span className="font-mono text-[10px] tabular-nums text-[var(--glass-muted)]">{time}</span>
            <span className="min-w-0">
              <span className="block truncate text-[11.5px] leading-4">{source}</span>
              <span className="block truncate text-[11.5px] leading-4 text-[var(--glass-muted)]">{target}</span>
            </span>
          </div>)}
      </Glass>
    </DepthLayer>
    <DepthLayer depth={62} x={x} y={y} className="featured-art-pill">
      <span className="featured-pill"><Check className="size-3" aria-hidden />{t("tools:catalog.art_studio_export")}</span>
    </DepthLayer>
  </>;
}

function KnowledgeArt({ x, y }: { x: MotionValue<number>; y: MotionValue<number> }) {
  const { t } = useTranslation();
  return <>
    <DepthLayer depth={14} x={x} y={y} className="featured-art-collection">
      <Glass className="flex items-center gap-2.5 p-3">
        <SmoothCorners radius={9} smoothing={0.72} className="flex size-8 shrink-0 items-center justify-center bg-[var(--feature-ink)] text-white">
          <BookOpenText className="size-4" aria-hidden />
        </SmoothCorners>
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-semibold leading-4">{t("tools:catalog.art_knowledge_collection")}</span>
          <span className="block truncate text-[10.5px] leading-4 text-[var(--glass-muted)]">{t("tools:catalog.art_knowledge_meta", { count: 128 })}</span>
        </span>
      </Glass>
    </DepthLayer>
    <DepthLayer depth={34} x={x} y={y} className="featured-art-terms">
      <Glass className="py-1.5">
        <div className="px-3 pt-1 pb-1.5 text-[10.5px] font-medium text-[var(--glass-muted)]">{t("tools:catalog.art_knowledge_terms")}</div>
        {[["シャドウ", "影子"], ["ホロウ", "空洞"], ["エーテル", "以太"]].map(([source, target], index) =>
          <div key={source} className={`featured-term ${index === 0 ? "is-active" : ""}`}>
            <span className="min-w-0 truncate text-[11.5px]">{source}</span>
            <ArrowRight className="size-3 shrink-0 text-[var(--glass-muted)]" aria-hidden />
            <span className="min-w-0 truncate text-[11.5px] font-medium">{target}</span>
          </div>)}
      </Glass>
    </DepthLayer>
    <DepthLayer depth={62} x={x} y={y} className="featured-art-pill">
      <span className="featured-pill"><Sparkles className="size-3" aria-hidden />{t("tools:catalog.art_knowledge_used")}</span>
    </DepthLayer>
  </>;
}

/**
 * A featured tool: a living gradient under glass, tilting towards the pointer with the artwork's panels
 * at different depths and a light that follows the pointer. The whole card is the link.
 */
export function FeaturedToolCard({ id, kind, to, index, eyebrowIcon, title, description, chips, details, cta }: {
  id: string; kind: FeaturedKind; to: string; index: number; eyebrowIcon: ReactNode; title: string; description: string;
  chips: string[]; details: [string, string][]; cta: string;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotionPreference();
  const isDark = useThemeStore((state) => state.isDark);
  const ref = useRef<HTMLAnchorElement>(null);
  const gradient = useRef<MeshGradientHandle>(null);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const sx = useSpring(mx, TILT_SPRING);
  const sy = useSpring(my, TILT_SPRING);
  const rotateY = useTransform(sx, [0, 1], [-5, 5]);
  const rotateX = useTransform(sy, [0, 1], [4, -4]);
  const glareX = useTransform(sx, (value) => `${value * 100}%`);
  const glareY = useTransform(sy, (value) => `${value * 100}%`);
  const glare = useMotionTemplate`radial-gradient(circle at ${glareX} ${glareY}, var(--feature-glare), transparent 55%)`;
  const lift = useSpring(0, { stiffness: 220, damping: 22 });

  const move = (event: React.PointerEvent) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds?.width || event.pointerType === "touch") return;
    const point = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
    gradient.current?.point(point);
    if (reduceMotion) return;
    mx.set(point.x); my.set(point.y);
  };
  const leave = () => { mx.set(0.5); my.set(0.5); lift.set(0); gradient.current?.point(null); };

  return <motion.div className="featured-tool-wrap" initial={reduceMotion ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.7, delay: 0.06 + index * 0.08, ease: EASE }}>
    <MotionLink ref={ref} to={to} data-tool-card={id} aria-labelledby={`tool-title-${id}`}
      className={`featured-tool featured-tool--${kind} group`}
      style={{ rotateX, rotateY, z: lift }}
      onPointerMove={move} onPointerEnter={(event) => { if (!reduceMotion) lift.set(18); move(event); }} onPointerLeave={leave} onBlur={leave}>
      <SmoothCorners radius={24} smoothing={0.72} className="featured-surface" aria-hidden>
        <MeshGradient ref={gradient} colors={PALETTES[kind][isDark ? "dark" : "light"]} dark={isDark} className="absolute inset-0 size-full" />
        <div className="featured-veil" />
        <motion.div className="featured-glare" style={{ background: glare }} />
      </SmoothCorners>

      <div className="featured-copy">
        <span className="featured-eyebrow">{eyebrowIcon}{t("tools:catalog.featured")}</span>
        <h2 id={`tool-title-${id}`} className="featured-title">{title}</h2>
        <p className="featured-description">{description}</p>
        <ul className="featured-chips" aria-label={t("tools:catalog.features")}>
          {chips.map((chip) => <li key={chip}>{chip}</li>)}
        </ul>
      </div>

      <div className="featured-footer">
        <dl className="featured-details">
          {details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <span className="featured-cta">{cta}<ArrowRight aria-hidden className="size-4" /></span>
      </div>

      <div className="featured-art" aria-hidden>
        {kind === "studio" ? <StudioArt x={sx} y={sy} /> : <KnowledgeArt x={sx} y={sy} />}
      </div>
    </MotionLink>
  </motion.div>;
}
