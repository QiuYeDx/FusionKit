import { useRef, type CSSProperties, type ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import "./page-kit.css";

// ---------------------------------------------------------------------------
// The building blocks of FusionKit's own pages (settings, help, about), in the
// tools catalog's language: see page-kit.css.
// ---------------------------------------------------------------------------

export const PAGE_EASE = [0.23, 1, 0.32, 1] as const;

/** Tones for icons and tiles: the tools' colours plus a neutral and an amber. */
export const TONES = {
  neutral: "var(--kit-tone-neutral)",
  amber: "var(--kit-tone-amber)",
  orange: "var(--tool-translator)",
  blue: "var(--tool-converter)",
  green: "var(--tool-extractor)",
  teal: "var(--tool-local-subtitle)",
  violet: "var(--tool-rename)",
  cyan: "var(--tool-text)",
} as const;
export type Tone = keyof typeof TONES;
export const toneStyle = (tone: Tone) => ({ "--kit-tone": TONES[tone] }) as CSSProperties;

/** The page's title: a mono eyebrow, the title and one line about the page; actions sit at the right. */
export function PageHeader({ eyebrow, title, description, actions, before, className }: {
  eyebrow: string; title: string; description?: ReactNode; actions?: ReactNode; before?: ReactNode; className?: string;
}) {
  const reduceMotion = useReducedMotionPreference();
  return <motion.header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}
    initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: PAGE_EASE }}>
    <div className="min-w-0 flex-1">
      {before}
      <p className="kit-eyebrow">FusionKit · {eyebrow}</p>
      <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-tight">{title}</h1>
      {description && <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </motion.header>;
}

/** A tinted icon tile in a tone; solid for navigation, where it marks the place. */
export function ToneIcon({ icon: Icon, tone, size = 32, radius, solid, className }: {
  icon: LucideIcon; tone: Tone; size?: number; radius?: number; solid?: boolean; className?: string;
}) {
  return <SmoothCorners radius={radius ?? Math.round(size * 0.3)} smoothing={0.72} className={cn("kit-tone-icon", className)}
    style={{ ...toneStyle(tone), width: size, height: size }} data-solid={solid || undefined} aria-hidden>
    <Icon style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} />
  </SmoothCorners>;
}

/** A section of a page: heading and description, an action at the right, then its content. */
export function PageSection({ id, title, description, action, children, className, testId }: {
  id?: string; title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; testId?: string;
}) {
  return <section id={id} className={cn("kit-section", className)} aria-labelledby={id ? `${id}-title` : undefined} data-testid={testId}>
    <div className="kit-section-head">
      <div className="min-w-0">
        <h2 id={id ? `${id}-title` : undefined} className="kit-section-title">{title}</h2>
        {description && <p className="kit-section-description">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
    {children}
  </section>;
}

/** A grouped panel of rows. */
export function Panel({ children, className, testId, ...rest }: { children: ReactNode; className?: string; testId?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <SmoothCorners radius={18} smoothing={0.72} className={cn("kit-panel", className)} data-testid={testId} {...rest}>{children}</SmoothCorners>;
}

/**
 * A row of a panel: what it is on the left, its control on the right (or below on a narrow page), and
 * anything that belongs to it underneath. With htmlFor the whole row is the control's label.
 */
export function PanelRow({ icon, tone = "neutral", label, description, control, wide, children, htmlFor, className, testId, labelId }: {
  icon?: LucideIcon; tone?: Tone; label: ReactNode; description?: ReactNode; control?: ReactNode;
  /** The control takes the rest of the row, for segmented controls and selects. */
  wide?: boolean; children?: ReactNode; htmlFor?: string; className?: string; testId?: string; labelId?: string;
}) {
  const Root = htmlFor ? "label" : "div";
  return <Root className={cn("kit-row", className)} htmlFor={htmlFor} data-icon={icon ? "" : undefined} data-testid={testId}>
    <div className="kit-row-main">
      {icon && <ToneIcon icon={icon} tone={tone} size={32} />}
      <div className="min-w-0 flex-1">
        <div className="kit-row-label" id={labelId}>{label}</div>
        {description && <div className="kit-row-description">{description}</div>}
      </div>
    </div>
    {control && <div className="kit-row-control" data-wide={wide || undefined}>{control}</div>}
    {children && <div className="kit-row-body">{children}</div>}
  </Root>;
}

/** A tile whose border catches the light under the pointer. */
export function SpotlightTile({ tone, className, children, as = "div", ...rest }: {
  tone: Tone; className?: string; children: ReactNode; as?: "div" | "a" | "button";
} & React.HTMLAttributes<HTMLElement> & { href?: string; type?: "button" }) {
  const ref = useRef<HTMLElement>(null);
  const spot = (event: React.PointerEvent) => {
    const element = ref.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    element.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
    element.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
  };
  const Tag = as as "div";
  return <SmoothCorners radius={18} smoothing={0.72} asChild>
    <Tag ref={ref as never} className={cn("kit-tile", className)} style={toneStyle(tone)} onPointerMove={spot} {...rest}>{children}</Tag>
  </SmoothCorners>;
}

/** Content that rises into place after the header, staggered by index. */
export function Rise({ index = 0, children, className }: { index?: number; children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotionPreference();
  return <motion.div className={className} initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.55, delay: 0.08 + index * 0.05, ease: PAGE_EASE }}>{children}</motion.div>;
}
