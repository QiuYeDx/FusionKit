// ---------------------------------------------------------------------------
// A slowly flowing mesh gradient (after motion-3d-lab's "渐变网格"): four soft
// colour blobs drift through a base colour, the space between them bent by two
// octaves of noise, and a pointer pushes the colours aside. One hidden WebGL
// context draws every gradient on screen and copies each frame into that
// gradient's own 2D canvas, like the agent orb.
// ---------------------------------------------------------------------------

import { SIMPLEX_3D } from "./simplex-noise";

/** Colour 0 is the base the blobs float in; 1–4 are the blobs. sRGB hex. */
export type GradientPalette = readonly [string, string, string, string, string];

const VERT = /* glsl */ `
attribute vec2 position;
varying vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uC[5];
uniform vec2 uPointer;
uniform float uPush;
uniform float uDark;
${SIMPLEX_3D}
void main() {
  float asp = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(asp, 1.0);
  float t = uTime;
  // Two octaves of domain warp: the blobs bend instead of being round.
  vec2 q = p;
  q += 0.22 * vec2(snoise(vec3(p * 1.1, t * 0.06)), snoise(vec3(p * 1.1 + 7.3, t * 0.06 + 2.0)));
  q += 0.07 * vec2(snoise(vec3(q * 2.7, t * 0.1 + 3.0)), snoise(vec3(q * 2.7 + 1.7, t * 0.1 + 5.0)));
  // The pointer pushes space outward.
  vec2 dp = q - uPointer;
  float fall = exp(-dot(dp, dp) * 6.0);
  q += normalize(dp + 1e-4) * fall * 0.18 * uPush;
  float sx = max(asp, 0.75) * 0.5;
  vec2 c1 = vec2(sin(t * 0.090 + 0.0) * sx * 0.9, cos(t * 0.070 + 1.0) * 0.36);
  vec2 c2 = vec2(cos(t * 0.075 + 2.1) * sx * 0.85, sin(t * 0.095 + 0.4) * 0.40);
  vec2 c3 = vec2(sin(t * 0.060 + 4.2) * sx * 0.7, sin(t * 0.083 + 3.3) * 0.42);
  vec2 c4 = vec2(cos(t * 0.105 + 5.0) * sx * 0.8, cos(t * 0.064 + 2.6) * 0.38);
  // Each blob dominates its neighbourhood; the base fills the rest.
  float w0 = 0.9;
  float w1 = 1.0 / pow(length(q - c1) + 0.06, 2.4);
  float w2 = 1.0 / pow(length(q - c2) + 0.06, 2.4);
  float w3 = 1.0 / pow(length(q - c3) + 0.06, 2.4);
  float w4 = 1.0 / pow(length(q - c4) + 0.06, 2.4);
  vec3 col = (uC[0] * w0 + uC[1] * w1 + uC[2] * w2 + uC[3] * w3 + uC[4] * w4) / (w0 + w1 + w2 + w3 + w4);
  // A soft sheen along a slow noise ridge.
  float ridge = 1.0 - abs(snoise(vec3(q * 1.1 + 11.0, t * 0.05)));
  col += pow(ridge, 3.0) * mix(0.035, 0.025, uDark);
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface GradientInstance {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  colors: number[][];
  dark: boolean;
  /** -0.5…0.5 in the canvas, y up; eased towards target. */
  pointer: { x: number; y: number; tx: number; ty: number };
  push: number;
  pushTarget: number;
  time: number;
  visible: boolean;
  still: boolean;
  dirty: boolean;
}

interface Context {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  quad: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

let shared: Context | null | undefined;
const instances = new Set<GradientInstance>();
let frame: number | null = null;
let last = 0;

function setup(): Context | null {
  if (shared !== undefined) return shared;
  shared = null;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false, depth: false });
  if (!gl) return null;
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.warn("[mesh-gradient]", gl.getShaderInfoLog(shader)); return null; }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, "position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const uniforms = Object.fromEntries(["uRes", "uTime", "uC", "uPointer", "uPush", "uDark"].map((name) => [name, gl.getUniformLocation(program, name)]));
  canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); shared = undefined; });
  shared = { gl, canvas, program, quad, uniforms };
  return shared;
}

export const gradientSupported = () => !!setup();

export function hexToRgb(hex: string): number[] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const damp = (current: number, target: number, lambda: number, dt: number) => current + (target - current) * (1 - Math.exp(-lambda * dt));

function draw(context: Context, instance: GradientInstance) {
  const { gl, canvas, uniforms } = context;
  const { width, height } = instance.canvas;
  if (!width || !height) return;
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
  }
  gl.viewport(0, 0, width, height);
  gl.useProgram(context.program);
  gl.uniform2f(uniforms.uRes, width, height);
  gl.uniform1f(uniforms.uTime, instance.time);
  gl.uniform3fv(uniforms.uC, new Float32Array(instance.colors.flat()));
  const aspect = width / height;
  gl.uniform2f(uniforms.uPointer, instance.pointer.x * aspect, instance.pointer.y);
  gl.uniform1f(uniforms.uPush, instance.push);
  gl.uniform1f(uniforms.uDark, instance.dark ? 1 : 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, context.quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // WebGL's origin is the bottom left: the drawn rectangle is the canvas's bottom rows.
  instance.context.drawImage(canvas, 0, canvas.height - height, width, height, 0, 0, width, height);
  instance.dirty = false;
}

function tick(now: number) {
  frame = null;
  const context = setup();
  if (!context) return;
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  let animating = false;
  for (const instance of instances) {
    if (!instance.visible) continue;
    if (instance.still) { if (instance.dirty) draw(context, instance); continue; }
    instance.time += dt;
    instance.pointer.x = damp(instance.pointer.x, instance.pointer.tx, 3, dt);
    instance.pointer.y = damp(instance.pointer.y, instance.pointer.ty, 3, dt);
    instance.push = damp(instance.push, instance.pushTarget, 2.4, dt);
    draw(context, instance);
    animating = true;
  }
  if (animating) frame = requestAnimationFrame(tick);
  else last = 0;
}

export function requestGradientFrame(): void {
  if (frame === null && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(tick);
}

export function createGradientInstance(canvas: HTMLCanvasElement, options: { colors: GradientPalette; dark: boolean; still: boolean; seed?: number }): GradientInstance | null {
  if (!setup()) return null;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  const instance: GradientInstance = {
    canvas, context, colors: options.colors.map(hexToRgb), dark: options.dark,
    pointer: { x: 0, y: -0.6, tx: 0, ty: -0.6 }, push: 0, pushTarget: 0,
    // A different moment for each gradient, so two side by side never look alike.
    time: options.seed ?? Math.random() * 40 + 20, visible: true, still: options.still, dirty: true,
  };
  instances.add(instance);
  requestGradientFrame();
  return instance;
}

export function releaseGradientInstance(instance: GradientInstance): void {
  instances.delete(instance);
}

export function updateGradientInstance(instance: GradientInstance, changes: { colors?: GradientPalette; dark?: boolean; visible?: boolean; still?: boolean }): void {
  if (changes.colors) instance.colors = changes.colors.map(hexToRgb);
  if (changes.dark !== undefined) instance.dark = changes.dark;
  if (changes.visible !== undefined) instance.visible = changes.visible;
  if (changes.still !== undefined) instance.still = changes.still;
  instance.dirty = true;
  requestGradientFrame();
}

/** Where the pointer is over the gradient (0…1 from the top left), or null once it left. */
export function pointGradientInstance(instance: GradientInstance, point: { x: number; y: number } | null): void {
  if (point) { instance.pointer.tx = point.x - 0.5; instance.pointer.ty = 0.5 - point.y; instance.pushTarget = 1; }
  else instance.pushTarget = 0;
}
