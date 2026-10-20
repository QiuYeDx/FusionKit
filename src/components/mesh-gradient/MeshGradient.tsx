import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import {
  createGradientInstance, pointGradientInstance, releaseGradientInstance, updateGradientInstance,
  type GradientInstance, type GradientPalette,
} from "./mesh-gradient-renderer";

export type { GradientPalette } from "./mesh-gradient-renderer";

export interface MeshGradientHandle {
  /** The pointer over the gradient, 0…1 from the top left; null when it leaves. */
  point: (point: { x: number; y: number } | null) => void;
}

/**
 * A flowing mesh gradient filling its parent. It is drawn at a fraction of the screen's pixels (it is
 * all soft colour), only while on screen, and holds still for reduced motion. Without WebGL it is a
 * static CSS gradient of the same colours.
 */
const MeshGradient = forwardRef<MeshGradientHandle, {
  colors: GradientPalette;
  dark: boolean;
  className?: string;
  /** Pixels per CSS pixel. */
  resolution?: number;
}>(function MeshGradient({ colors, dark, className, resolution = 0.6 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<GradientInstance | null>(null);
  const [fallback, setFallback] = useState(false);
  const reduceMotion = useReducedMotionPreference();

  useImperativeHandle(ref, () => ({ point: (point) => { if (instanceRef.current) pointGradientInstance(instanceRef.current, point); } }), []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = createGradientInstance(canvas, { colors, dark, still: reduceMotion });
    if (!instance) { setFallback(true); return; }
    instanceRef.current = instance;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width * resolution));
      const height = Math.max(1, Math.round(rect.height * resolution));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; updateGradientInstance(instance, {}); }
    };
    resize();
    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    const sight = new IntersectionObserver(([entry]) => updateGradientInstance(instance, { visible: entry.isIntersecting }));
    sight.observe(canvas);
    return () => { sizes.disconnect(); sight.disconnect(); releaseGradientInstance(instance); instanceRef.current = null; };
    // Colours, theme and motion are applied below without recreating the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution]);

  useEffect(() => {
    if (instanceRef.current) updateGradientInstance(instanceRef.current, { colors, dark, still: reduceMotion });
  }, [colors, dark, reduceMotion]);

  if (fallback) {
    return <div aria-hidden className={cn("pointer-events-none", className)} style={{
      background: `radial-gradient(60% 80% at 80% 30%, ${colors[1]}, transparent), radial-gradient(50% 70% at 20% 80%, ${colors[2]}, transparent), radial-gradient(40% 60% at 60% 90%, ${colors[3]}, transparent), ${colors[0]}`,
    }} />;
  }
  return <canvas ref={canvasRef} aria-hidden className={cn("pointer-events-none block", className)} />;
});

export default MeshGradient;
