// ---------------------------------------------------------------------------
// The agent orb: a liquid sphere whose surface is displaced by simplex noise,
// with an iridescent thin-film rim (after motion-3d-lab's "AI 光球"). One hidden
// WebGL context draws every orb on screen in turn and copies each frame into
// that orb's own 2D canvas, so any number of orbs costs one GPU context.
// ---------------------------------------------------------------------------

import { SIMPLEX_3D } from "@/components/mesh-gradient/simplex-noise";

export type OrbState = "idle" | "listen" | "think" | "answer";

type Params = { amp: number; freq: number; speed: number; hue: number; scale: number; swirl: number; glow: number; drift: number };
const PARAM_KEYS = ["amp", "freq", "speed", "hue", "scale", "swirl", "glow", "drift"] as const;

/** Idle breathes slowly; listening ripples with the input; thinking swirls; answering pulses like speech. */
export const ORB_STATES: Record<OrbState, Params> = {
  idle: { amp: 0.065, freq: 0.9, speed: 0.22, hue: 0.0, scale: 1, swirl: 0, glow: 0.6, drift: 0 },
  listen: { amp: 0.06, freq: 1.2, speed: 0.5, hue: 0.45, scale: 1.02, swirl: 0, glow: 0.6, drift: 0 },
  think: { amp: 0.09, freq: 1.45, speed: 0.9, hue: 0.22, scale: 0.94, swirl: 1.9, glow: 0.75, drift: 0.16 },
  answer: { amp: 0.075, freq: 1.1, speed: 0.55, hue: 0.72, scale: 1.0, swirl: 0.4, glow: 1.05, drift: 0 },
};

/** Springs per parameter: the size bounces a little, everything else glides. */
const SPRING = { stiffness: 38, damping: 13 };
const SCALE_SPRING = { stiffness: 140, damping: 9 };

/** Cyclic violet → blue → cyan → pink film palette (sRGB stops, linearised). */
const PALETTE = /* glsl */ `
vec3 pal(float t) {
  t = fract(t) * 4.0;
  vec3 c0 = vec3(0.50, 0.36, 1.00);
  vec3 c1 = vec3(0.26, 0.52, 1.00);
  vec3 c2 = vec3(0.36, 0.92, 0.98);
  vec3 c3 = vec3(1.00, 0.46, 0.84);
  vec3 c = t < 1.0 ? mix(c0, c1, smoothstep(0.0, 1.0, t))
         : t < 2.0 ? mix(c1, c2, smoothstep(1.0, 2.0, t))
         : t < 3.0 ? mix(c2, c3, smoothstep(2.0, 3.0, t))
         : mix(c3, c0, smoothstep(3.0, 4.0, t));
  return pow(c, vec3(2.2));
}
`;

const ORB_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 uModel;
uniform mat4 uProjection;
uniform float uTime;
uniform float uAmp;
uniform float uFreq;
uniform float uSwirl;
uniform float uScale;
varying vec3 vN;
varying vec3 vSN;
varying vec3 vView;
varying float vDisp;
${SIMPLEX_3D}
float field(vec3 p) {
  vec3 q = p * uFreq;
  float a = uSwirl * p.y + uTime * 0.15 * uSwirl;
  float c = cos(a), s = sin(a);
  q.xz = mat2(c, -s, s, c) * q.xz;
  float n = snoise(q + vec3(0.0, uTime * 0.55, uTime * 0.3));
  n += 0.28 * snoise(q * 2.0 + vec3(uTime * 0.35, 0.0, -uTime * 0.2));
  return n;
}
vec3 displace(vec3 n) { return n * (1.0 + uAmp * field(n)); }
void main() {
  vec3 p = normalize(position);
  vec3 t = normalize(cross(p, abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(p, t);
  float e = 0.012;
  float f0 = field(p);
  vec3 d0 = p * (1.0 + uAmp * f0);
  vec3 d1 = displace(normalize(p + t * e));
  vec3 d2 = displace(normalize(p + b * e));
  vec3 nrm = normalize(cross(d1 - d0, d2 - d0));
  vDisp = f0;
  vec4 mv = uModel * vec4(d0 * uScale, 1.0);
  mat3 rot = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz);
  vN = normalize(rot * nrm);
  vSN = normalize(rot * p);
  vView = normalize(-mv.xyz);
  gl_Position = uProjection * mv;
}
`;

const ORB_FRAG = /* glsl */ `
precision highp float;
uniform float uHue;
uniform float uGlow;
uniform float uLight;
varying vec3 vN;
varying vec3 vSN;
varying vec3 vView;
varying float vDisp;
${PALETTE}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vView);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fr = pow(1.0 - ndv, 2.4);
  vec3 base = pal(uHue);
  vec3 rimC = pal(uHue + 0.1 + (1.0 - ndv) * 0.12 + vDisp * 0.05);
  vec3 film = pal(uHue - 0.08 + vDisp * 0.12);
  float band = 0.5 + 0.5 * sin(vDisp * 8.0 + ndv * 6.0);

  // Dark: a glassy body with a soft luminous core. Light: a pearl, tinted towards the rim.
  vec3 dark = base * 0.012 + base * pow(ndv, 3.0) * uGlow * 0.15;
  dark += film * band * pow(1.0 - ndv, 1.4) * 0.28;
  dark += rimC * fr * 1.6;
  vec3 light = mix(vec3(0.94, 0.94, 0.99), base, 0.16) * (0.88 + 0.12 * ndv);
  light = mix(light, film, band * pow(1.0 - ndv, 1.3) * 0.6);
  light = mix(light, rimC, clamp(fr * 1.5, 0.0, 1.0));
  vec3 col = mix(dark, light, uLight);

  // Studio reflections: a soft top strip and one sharp key highlight that wobbles with the surface.
  vec3 r = reflect(-v, n);
  col += smoothstep(0.45, 0.95, r.y) * smoothstep(-0.2, 0.6, r.z) * 0.1 * mix(vec3(1.0), rimC, 0.4);
  vec3 l1 = normalize(vec3(-0.45, 0.75, 0.6));
  vec3 l2 = normalize(vec3(0.7, -0.35, 0.4));
  vec3 ns = normalize(mix(n, normalize(vSN), 0.82));
  col += pow(max(dot(ns, normalize(l1 + v)), 0.0), 320.0) * 1.1 + pow(max(dot(n, normalize(l1 + v)), 0.0), 40.0) * 0.08;
  col += pow(max(dot(ns, normalize(l2 + v)), 0.0), 50.0) * pal(uHue + 0.25) * 0.22;

  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;

const HALO_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** The glow around the orb, which the demo's bloom used to give; premultiplied alpha. */
const HALO_FRAG = /* glsl */ `
precision highp float;
uniform float uHue;
uniform float uGlow;
uniform float uLight;
uniform float uRadius;
varying vec2 vUv;
${PALETTE}
void main() {
  // d: 0 at the centre, 1 at the canvas edge; the sphere's edge is at uRadius.
  float d = length(vUv - 0.5) * 2.0;
  float edge = max(d - uRadius * 0.9, 0.0) / max(1.0 - uRadius * 0.9, 0.05);
  float g = exp(-edge * edge * 5.0) * 0.5 + exp(-d * d * 1.4) * 0.06;
  g *= uGlow * mix(1.0, 0.7, uLight) * smoothstep(1.0, 0.82, d);
  vec3 c = pow(pal(uHue + 0.06), vec3(1.0 / 2.2));
  float a = clamp(g, 0.0, 1.0);
  gl_FragColor = vec4(c * a, a);
}
`;

interface Spring { value: number; velocity: number }

export interface OrbInstance {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  state: OrbState;
  light: boolean;
  /** How much of the canvas's half-size the sphere's radius takes. */
  fill: number;
  halo: boolean;
  /** Tilts towards the pointer. */
  followPointer: boolean;
  visible: boolean;
  /** Freezes time: the orb is drawn once per change, without animating. */
  still: boolean;
  params: Record<(typeof PARAM_KEYS)[number], Spring>;
  clock: number;
  time: number;
  drift: number;
  voice: number;
  voiceTarget: number;
  syllable: number;
  talk: number;
  /** Typing energy, pushed in by the composer while listening. */
  energy: number;
  rotation: { x: number; y: number; z: number };
  dirty: boolean;
}

interface Programs {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  orb: WebGLProgram;
  halo: WebGLProgram;
  sphere: { buffer: WebGLBuffer; index: WebGLBuffer; count: number };
  quad: WebGLBuffer;
  uniforms: Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>;
}

let programs: Programs | null | undefined;
const instances = new Set<OrbInstance>();
let frame: number | null = null;
let last = 0;
const pointer = { x: 0, y: 0 };
let pointerBound = false;

function compile(gl: WebGLRenderingContext, vertex: string, fragment: string): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.warn("[agent-orb]", gl.getShaderInfoLog(shader)); return null; }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/** A UV sphere; the shader takes its normals from the positions, so the poles need no care. */
function sphereGeometry(rings: number, segments: number) {
  const positions: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const theta = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const phi = (segment / segments) * Math.PI * 2;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  }
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * (segments + 1) + segment;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

function setup(): Programs | null {
  if (programs !== undefined) return programs;
  programs = null;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false, depth: true });
  if (!gl) return null;
  const orb = compile(gl, ORB_VERT, ORB_FRAG);
  const halo = compile(gl, HALO_VERT, HALO_FRAG);
  if (!orb || !halo) return null;
  const geometry = sphereGeometry(64, 96);
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
  const index = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), gl.STATIC_DRAW);
  canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); programs = undefined; });
  programs = { gl, canvas, orb, halo, sphere: { buffer, index, count: geometry.indices.length }, quad, uniforms: new Map() };
  return programs;
}

export function orbSupported(): boolean {
  return !!setup();
}

function uniform(p: Programs, program: WebGLProgram, name: string) {
  let map = p.uniforms.get(program);
  if (!map) p.uniforms.set(program, map = new Map());
  if (!map.has(name)) map.set(name, p.gl.getUniformLocation(program, name));
  return map.get(name)!;
}

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

/** Rotation X·Y·Z, then moved back from the camera by distance. */
function model(rx: number, ry: number, rz: number, distance: number): Float32Array {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // Column-major R = Rx * Ry * Rz.
  const m00 = cy * cz, m01 = -cy * sz, m02 = sy;
  const m10 = sx * sy * cz + cx * sz, m11 = -sx * sy * sz + cx * cz, m12 = -sx * cy;
  const m20 = -cx * sy * cz + sx * sz, m21 = cx * sy * sz + sx * cz, m22 = cx * cy;
  return new Float32Array([m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0, 0, 0, -distance, 1]);
}

const damp = (current: number, target: number, lambda: number, dt: number) => current + (target - current) * (1 - Math.exp(-lambda * dt));

function step(instance: OrbInstance, dt: number) {
  const target = ORB_STATES[instance.state];
  for (const key of PARAM_KEYS) {
    const spring = instance.params[key];
    if (instance.still) { spring.value = target[key]; spring.velocity = 0; continue; }
    const { stiffness, damping } = key === "scale" ? SCALE_SPRING : SPRING;
    spring.velocity += (stiffness * (target[key] - spring.value) - damping * spring.velocity) * dt;
    spring.value += spring.velocity * dt;
  }
  if (instance.still) return;
  instance.clock += dt;
  instance.time += dt * instance.params.speed.value;
  const drift = instance.params.drift.value;
  instance.drift += dt * drift;
  // Once the swirl stops, the hue drift settles on a whole palette turn, which looks the same.
  if (drift < 0.02) instance.drift = damp(instance.drift, Math.round(instance.drift), 1.2, dt);
  // Listening: syllable-like bursts, scaled by how much the user is typing.
  instance.syllable -= dt;
  if (instance.syllable <= 0) {
    instance.syllable = 0.09 + Math.random() * 0.22;
    instance.voiceTarget = Math.random() < 0.78 ? 0.35 + Math.random() * 0.65 : 0.04;
  }
  instance.energy = damp(instance.energy, 0, 1.6, dt);
  const listening = instance.state === "listen" ? Math.min(1, 0.25 + instance.energy) : 0;
  instance.voice = damp(instance.voice, instance.voiceTarget * listening, 14, dt);
  const beat = Math.pow(0.5 + 0.5 * Math.sin(instance.clock * 7.2), 3) * (0.55 + 0.45 * Math.sin(instance.clock * 1.7));
  instance.talk = damp(instance.talk, instance.state === "answer" ? beat : 0, 10, dt);
  instance.rotation.y += dt * 0.08;
  const px = instance.followPointer ? pointer.x : 0;
  const py = instance.followPointer ? pointer.y : 0;
  instance.rotation.x = damp(instance.rotation.x, -py * 0.18, 2.5, dt);
  instance.rotation.z = damp(instance.rotation.z, px * -0.1, 2.5, dt);
}

function draw(p: Programs, instance: OrbInstance) {
  const { gl, canvas } = p;
  const width = instance.canvas.width;
  const height = instance.canvas.height;
  if (!width || !height) return;
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
  }
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const params = instance.params;
  const hue = params.hue.value + instance.drift;
  const glow = params.glow.value * (1 + instance.voice * 0.5 + instance.talk * 0.6);
  const light = instance.light ? 1 : 0;

  if (instance.halo) {
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(p.halo);
    gl.uniform1f(uniform(p, p.halo, "uHue"), hue);
    gl.uniform1f(uniform(p, p.halo, "uGlow"), glow);
    gl.uniform1f(uniform(p, p.halo, "uLight"), light);
    gl.uniform1f(uniform(p, p.halo, "uRadius"), instance.fill);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  gl.disable(gl.BLEND);
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(p.orb);
  // The sphere's radius covers `fill` of the half-height: the camera distance follows from the field of view.
  const fov = (30 * Math.PI) / 180;
  const distance = 1 / (instance.fill * Math.tan(fov / 2));
  gl.uniformMatrix4fv(uniform(p, p.orb, "uProjection"), false, perspective(fov, width / height, 0.1, 100));
  gl.uniformMatrix4fv(uniform(p, p.orb, "uModel"), false, model(instance.rotation.x, instance.rotation.y, instance.rotation.z, distance));
  gl.uniform1f(uniform(p, p.orb, "uTime"), instance.time);
  gl.uniform1f(uniform(p, p.orb, "uAmp"), params.amp.value + instance.voice * 0.075 + instance.talk * 0.03);
  gl.uniform1f(uniform(p, p.orb, "uFreq"), params.freq.value);
  gl.uniform1f(uniform(p, p.orb, "uSwirl"), params.swirl.value);
  // Perspective makes the bulge nearer the camera look larger; 0.9 keeps the silhouette inside fill.
  gl.uniform1f(uniform(p, p.orb, "uScale"), 0.9 * params.scale.value * (1 + instance.voice * 0.07 + instance.talk * 0.045));
  gl.uniform1f(uniform(p, p.orb, "uHue"), hue);
  gl.uniform1f(uniform(p, p.orb, "uGlow"), glow);
  gl.uniform1f(uniform(p, p.orb, "uLight"), light);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.sphere.buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.sphere.index);
  gl.drawElements(gl.TRIANGLES, p.sphere.count, gl.UNSIGNED_SHORT, 0);

  // WebGL's origin is the bottom left: the drawn square is the canvas's bottom rows.
  instance.context.clearRect(0, 0, width, height);
  instance.context.drawImage(canvas, 0, canvas.height - height, width, height, 0, 0, width, height);
  instance.dirty = false;
}

function tick(now: number) {
  frame = null;
  const p = setup();
  if (!p) return;
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  let animating = false;
  for (const instance of instances) {
    if (!instance.visible) continue;
    if (instance.still) { if (instance.dirty) { step(instance, dt); draw(p, instance); } continue; }
    step(instance, dt);
    draw(p, instance);
    animating = true;
  }
  if (animating) frame = requestAnimationFrame(tick);
  else last = 0;
}

/** Runs the loop while an orb on screen animates; a still orb only asks for one frame. */
export function requestOrbFrame(): void {
  if (frame === null && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
}

function onPointerMove(event: PointerEvent) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -((event.clientY / window.innerHeight) * 2 - 1);
}

export function createOrbInstance(canvas: HTMLCanvasElement, options: Pick<OrbInstance, "state" | "light" | "fill" | "halo" | "followPointer" | "still">): OrbInstance | null {
  if (!setup()) return null;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const start = ORB_STATES[options.state];
  const instance: OrbInstance = {
    canvas, context, ...options, visible: true,
    params: Object.fromEntries(PARAM_KEYS.map((key) => [key, { value: start[key], velocity: 0 }])) as OrbInstance["params"],
    // Each orb starts at its own moment, so two on screen never move in step.
    clock: Math.random() * 10, time: Math.random() * 10, drift: 0, voice: 0, voiceTarget: 0, syllable: 0, talk: 0, energy: 0,
    rotation: { x: 0, y: Math.random() * Math.PI * 2, z: 0 }, dirty: true,
  };
  instances.add(instance);
  if (options.followPointer && !pointerBound) { window.addEventListener("pointermove", onPointerMove, { passive: true }); pointerBound = true; }
  requestOrbFrame();
  return instance;
}

export function releaseOrbInstance(instance: OrbInstance): void {
  instances.delete(instance);
  if (pointerBound && ![...instances].some((item) => item.followPointer)) { window.removeEventListener("pointermove", onPointerMove); pointerBound = false; }
}

export function updateOrbInstance(instance: OrbInstance, changes: Partial<Pick<OrbInstance, "state" | "light" | "fill" | "halo" | "visible" | "still">>): void {
  Object.assign(instance, changes);
  instance.dirty = true;
  requestOrbFrame();
}

/** A burst of listening energy, for example a keystroke. */
export function nudgeOrbInstance(instance: OrbInstance, amount = 0.35): void {
  instance.energy = Math.min(1.4, instance.energy + amount);
}
