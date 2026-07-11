import { useEffect, useState } from "react";

export function useElapsedMs(
  startedAtMs: number | null,
  active: boolean,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (startedAtMs === null) return;
    setNowMs(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAtMs]);

  return startedAtMs === null ? 0 : Math.max(0, nowMs - startedAtMs);
}
