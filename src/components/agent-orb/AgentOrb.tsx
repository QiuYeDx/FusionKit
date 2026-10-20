import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import useThemeStore from "@/store/useThemeStore";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import "./agent-orb.css";
import { createOrbInstance, nudgeOrbInstance, releaseOrbInstance, updateOrbInstance, type OrbInstance, type OrbState } from "./orb-renderer";

export type { OrbState } from "./orb-renderer";

export interface AgentOrbHandle {
  /** A burst of listening energy, such as a keystroke. */
  nudge: (amount?: number) => void;
}

/**
 * The agent's orb. size is the square it is drawn in; fill is how much of it the sphere takes, the rest
 * is its glow (without glow the sphere can fill more). Paused, it keeps its last frame and costs nothing.
 * Without WebGL it is a soft gradient circle.
 */
const AgentOrb = forwardRef<AgentOrbHandle, {
  state?: OrbState;
  size: number;
  fill?: number;
  halo?: boolean;
  followPointer?: boolean;
  paused?: boolean;
  className?: string;
  testId?: string;
}>(function AgentOrb({ state = "idle", size, fill = 0.62, halo = true, followPointer = false, paused = false, className, testId }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<OrbInstance | null>(null);
  const [fallback, setFallback] = useState(false);
  const isDark = useThemeStore((store) => store.isDark);
  const reduceMotion = useReducedMotionPreference();
  const [onScreen, setOnScreen] = useState(true);

  useImperativeHandle(ref, () => ({ nudge: (amount) => { if (instanceRef.current) nudgeOrbInstance(instanceRef.current, amount); } }), []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    if (instanceRef.current) { updateOrbInstance(instanceRef.current, {}); return; }
    const instance = createOrbInstance(canvas, { state, light: !isDark, fill, halo, followPointer, still: reduceMotion });
    if (!instance) { setFallback(true); return; }
    instanceRef.current = instance;
    // The props below are applied by their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);
  useEffect(() => () => { if (instanceRef.current) releaseOrbInstance(instanceRef.current); instanceRef.current = null; }, []);

  // Off screen (scrolled away or in a hidden panel), the orb is not drawn.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (instanceRef.current) updateOrbInstance(instanceRef.current, { state, light: !isDark, fill, halo, still: reduceMotion, visible: onScreen && !paused });
  }, [state, isDark, fill, halo, reduceMotion, onScreen, paused]);

  if (fallback) {
    return <span aria-hidden data-testid={testId} data-orb-state={state} className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <span className="agent-orb-fallback absolute rounded-full" style={{ inset: `${((1 - fill) / 2) * 100}%` }} />
    </span>;
  }
  return <canvas ref={canvasRef} aria-hidden data-testid={testId} data-orb-state={state}
    className={cn("pointer-events-none block shrink-0", className)} style={{ width: size, height: size }} />;
});

export default AgentOrb;
