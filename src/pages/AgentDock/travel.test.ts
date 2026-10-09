import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { travel } from "./travel";

let frames: Map<number, FrameRequestCallback>;
let now = 0;
let nextId = 1;
beforeEach(() => {
  frames = new Map(); now = 0; nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(nextId, callback); return nextId++; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => vi.unstubAllGlobals());

/** Runs frames every `step` ms for at most `limit` ms, recording the point after each. */
function run(x: { get(): number }, y: { get(): number }, limit = 3000, step = 1000 / 60) {
  const path: { time: number; x: number; y: number }[] = [];
  while (frames.size && now < limit) {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(now);
    path.push({ time: now, x: x.get(), y: y.get() });
    now += step;
  }
  return path;
}
const value = (initial: number) => { let current = initial; return { get: () => current, set: (next: number) => { current = next; } }; };

describe("travel", () => {
  it("overshoots a long trip by the given pixels along its line, then rests exactly on the target", () => {
    const x = value(857), y = value(-134);
    travel(x, y, { x: 0, y: 47 }, { duration: 0.4, overshoot: 8 });
    const path = run(x, y);
    expect(frames.size).toBe(0);
    expect(path.at(-1)).toMatchObject({ x: 0, y: 47 });
    // Past the target on the far side of the line it came along.
    const peak = Math.max(...path.map((point) => -point.x));
    expect(peak).toBeGreaterThan(7);
    expect(peak).toBeLessThan(9);
    const deepest = path.find((point) => -point.x === peak)!;
    expect((deepest.y - 47) / -deepest.x).toBeCloseTo((47 + 134) / 857, 5);
    // It arrives in about the visual duration and comes to rest soon after.
    expect(path.find((point) => point.x <= 0)!.time).toBeLessThan(600);
    expect(path.at(-1)!.time).toBeLessThan(1100);
  });

  it("overshoots the same few pixels on a short trip, limited to a share of it", () => {
    for (const [distance, expected] of [[334, 8], [47, 47 * 0.15]] as const) {
      now = 0;
      const x = value(0), y = value(0);
      travel(x, y, { x: distance, y: 0 }, { duration: 0.4, overshoot: 8 });
      const peak = Math.max(...run(x, y).map((point) => point.x)) - distance;
      expect(Math.abs(peak - expected)).toBeLessThan(1);
    }
  });

  it("moves without overshoot when asked to, and continues an interrupted move", () => {
    const x = value(0), y = value(0);
    travel(x, y, { x: 0, y: 200 }, { duration: 0.4, overshoot: 0 });
    const path = run(x, y);
    expect(Math.max(...path.map((point) => point.y))).toBe(200);
    expect(path.at(-1)!.y).toBe(200);

    now = 0;
    const stop = travel(x, y, { x: 0, y: 0 }, { duration: 0.4, overshoot: 8 });
    run(x, y, 100);
    const velocity = stop();
    expect(frames.size).toBe(0);
    expect(velocity.x).toBe(0);
    expect(velocity.y).toBeLessThan(-200);
    // Turning back, it first keeps going the way it was moving.
    const at = y.get();
    travel(x, y, { x: 0, y: 200 }, { duration: 0.4, overshoot: 8, velocity });
    const turned = run(x, y);
    expect(Math.min(...turned.map((point) => point.y))).toBeLessThan(at);
    expect(turned.at(-1)!.y).toBe(200);
  });
});
