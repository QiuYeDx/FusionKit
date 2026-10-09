type Point = { x: number; y: number };
type Value = { get(): number; set(value: number): void };
type State = [position: number, velocity: number];

/** The landing spring: lively (damping ratio 0.55), settling in about a quarter second. */
const LANDING_FREQUENCY = 20;
const LANDING_DAMPING = 0.55;
const LANDING_DAMPED = LANDING_FREQUENCY * Math.sqrt(1 - LANDING_DAMPING ** 2);
/** A landing that starts at the target with speed v first runs on by v * LANDING_PEAK. */
const LANDING_PEAK = (() => {
  const time = Math.atan2(Math.sqrt(1 - LANDING_DAMPING ** 2), LANDING_DAMPING) / LANDING_DAMPED;
  return Math.exp(-LANDING_DAMPING * LANDING_FREQUENCY * time) * Math.sin(LANDING_DAMPED * time) / LANDING_DAMPED;
})();
/** Rest: closer than this many pixels and slower than this many pixels per second. */
const REST_DISTANCE = 0.1;
const REST_SPEED = 2;

/** A critically damped spring from 0, at a given speed, toward `aim`. */
function approach(aim: number, speed: number, frequency: number) {
  const c2 = speed - frequency * aim;
  return (time: number): State => {
    const decay = Math.exp(-frequency * time);
    return [aim + (-aim + c2 * time) * decay, decay * (c2 - frequency * (-aim + c2 * time))];
  };
}

/** The underdamped landing around the target, starting on it at a given speed. */
function landing(speed: number) {
  return (time: number): State => {
    const decay = Math.exp(-LANDING_DAMPING * LANDING_FREQUENCY * time) * speed / LANDING_DAMPED;
    const angle = LANDING_DAMPED * time;
    return [decay * Math.sin(angle), decay * (LANDING_DAMPED * Math.cos(angle) - LANDING_DAMPING * LANDING_FREQUENCY * Math.sin(angle))];
  };
}

/**
 * How far past the target the approach must aim to arrive fast enough for the landing to overshoot by
 * `overshoot`. The arrival speed depends on the aim, so this settles it in a few rounds.
 */
export function reachFor(distance: number, overshoot: number, frequency: number): number {
  let reach = overshoot / (LANDING_PEAK * frequency);
  for (let round = 0; round < 6; round++) {
    const aim = distance + reach;
    // The approach from rest crosses the target when (1 + s)e^-s = reach / aim, with s = frequency * time.
    let low = 0, high = 60;
    for (let step = 0; step < 50; step++) {
      const s = (low + high) / 2;
      if ((1 + s) * Math.exp(-s) > reach / aim) low = s; else high = s;
    }
    const s = (low + high) / 2;
    reach *= overshoot / (LANDING_PEAK * frequency * aim * s * Math.exp(-s));
  }
  return reach;
}

/**
 * Moves a point to a target like a thrown object: a damped approach that would come to rest a little
 * past the target, and from the moment it crosses the target a bouncy spring that carries its speed,
 * so it overshoots by about `overshoot` pixels along the line of travel and settles quickly. A single
 * spring cannot do this: its overshoot grows with the distance, and damping it down for long trips
 * makes the return creep. `velocity` continues an interrupted move. The approach reaches the target
 * in about `duration` seconds, like Motion's visualDuration.
 *
 * Returns a function that stops the move and gives its velocity at that moment.
 */
export function travel(x: Value, y: Value, target: Point, { duration, overshoot, velocity = { x: 0, y: 0 } }: { duration: number; overshoot: number; velocity?: Point }): () => Point {
  const from = { x: x.get(), y: y.get() };
  const distance = Math.hypot(target.x - from.x, target.y - from.y);
  if (distance < REST_DISTANCE) { x.set(target.x); y.set(target.y); return () => ({ x: 0, y: 0 }); }
  // Both axes follow one distance along the line, so the path and the overshoot stay on it; sideways
  // speed of an interrupted move is dropped.
  const along = { x: (target.x - from.x) / distance, y: (target.y - from.y) / distance };
  const frequency = (2 * Math.PI) / (duration * 1.2);
  // Short trips overshoot less, so a small move does not wobble.
  const pixels = Math.min(overshoot, distance * 0.15);
  const bounce = pixels >= 0.5;
  const toward = approach(distance + (bounce ? reachFor(distance, pixels, frequency) : 0), velocity.x * along.x + velocity.y * along.y, frequency);
  let land: ((time: number) => State) | null = null;
  let landedAt = 0;
  let start: number | null = null;
  let previous = 0;
  let speed = 0;
  let frame = 0;
  const place = (progress: number) => { x.set(from.x + along.x * progress); y.set(from.y + along.y * progress); };
  const step = (now: number) => {
    start ??= now;
    const time = (now - start) / 1000;
    let progress: number;
    if (!land) {
      [progress, speed] = toward(time);
      if (bounce && progress >= distance) {
        // Hand over at the exact moment of crossing, so position and speed carry on unbroken.
        let low = previous, high = time;
        for (let round = 0; round < 30; round++) { const middle = (low + high) / 2; if (toward(middle)[0] < distance) low = middle; else high = middle; }
        landedAt = high;
        land = landing(toward(landedAt)[1]);
      } else if (!bounce && Math.abs(distance - progress) < REST_DISTANCE && Math.abs(speed) < REST_SPEED) {
        place(distance); speed = 0; return;
      }
    }
    if (land) {
      const [offset, landingSpeed] = land(time - landedAt);
      progress = distance + offset; speed = landingSpeed;
      if (time - landedAt > 0.05 && Math.abs(offset) < REST_DISTANCE && Math.abs(speed) < REST_SPEED) { place(distance); speed = 0; return; }
    }
    previous = time;
    place(progress!);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => { cancelAnimationFrame(frame); return { x: along.x * speed, y: along.y * speed }; };
}
