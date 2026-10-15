// A point cloud that re-forms one word in another language, adapted from the
// particle-type demo in motion-3d-lab. Plain three.js (no react-three-fiber) so
// the hero only pays for the renderer; it is loaded lazily after first paint.
import * as THREE from 'three'

export type CloudTheme = 'light' | 'dark'

export type WordCloud = {
  show: (text: string, opts?: { duration?: number; scatter?: number }) => void
  setTheme: (theme: CloudTheme) => void
  setPointer: (x: number, y: number) => void
  setRunning: (running: boolean) => void
  dispose: () => void
}

const vert = /* glsl */ `
uniform float uProgress;
uniform float uTime;
uniform float uSize;
uniform float uScatter;
uniform float uStagger;
uniform float uDepth;
uniform float uWidth;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
attribute vec3 aTo;
attribute vec4 aRand;
varying vec3 vColor;
varying float vAlpha;

vec3 swirl(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.9 + t) + sin(p.z * 1.3 - t * 0.7),
    sin(p.z * 1.7 + t * 1.1) + sin(p.x * 1.1 + t * 0.6),
    sin(p.x * 1.5 - t * 0.9) + sin(p.y * 1.2 + t * 0.8)
  );
}

void main() {
  float delay = aRand.x * uStagger;
  float k = clamp((uProgress - delay) / (1.0 - uStagger), 0.0, 1.0);
  float e = k < 0.5 ? 4.0 * k * k * k : 1.0 - pow(-2.0 * k + 2.0, 3.0) / 2.0;
  vec3 p = mix(position, aTo, e);
  float mid = sin(e * 3.14159265);
  // Positions are in units of the stage height; the swirl works on that scale.
  p += swirl(p * 2.4, uTime * 0.6 + aRand.y * 6.2831) * mid * uScatter * (0.12 + aRand.z * 0.16);
  p += swirl(p * 4.0 + aRand.xyz, uTime * 0.5) * 0.004;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aRand.w * 0.8) * (1.0 + mid * 0.6) * (uDepth / -mv.z);
  // A left-to-right sweep from teal to violet, a few bright glints, brighter in flight.
  float sweep = smoothstep(-0.5, 0.5, p.x / uWidth + (aRand.y - 0.5) * 0.25);
  float glint = step(0.93, aRand.w);
  vColor = mix(mix(uColA, uColB, sweep), uColC, clamp(mid * 0.7 + glint * 0.6, 0.0, 1.0));
  vAlpha = 0.5 + aRand.z * 0.5;
}
`

// Dark: additive glow. Light: premultiplied "ink" so particles read on white.
const frag = /* glsl */ `
uniform float uAdditive;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a * vAlpha;
  if (a < 0.003) discard;
  vec3 glow = vColor * a * 1.6;
  gl_FragColor = uAdditive > 0.5 ? vec4(glow, a) : vec4(vColor * a, a);
}
`

// Studio teal, Knowledge violet and a highlight, per theme (see index.css).
const PALETTES: Record<CloudTheme, [string, string, string]> = {
  dark: ['#3fc7c9', '#a48cf0', '#f2fbff'],
  light: ['#0a9ea3', '#7055e4', '#3c74e6'],
}

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)

const FONT =
  '600 160px "Inter Variable", -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'

/** Samples the filled pixels of `text` as points, fitted into a box `maxW` × `maxH` (stage-height units). */
function textPoints(text: string, count: number, maxW: number, maxH: number) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.font = FONT
  const w = Math.ceil(ctx.measureText(text).width) + 40
  const h = 220
  canvas.width = w
  canvas.height = h
  ctx.font = FONT
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(text, w / 2, h / 2)
  const data = ctx.getImageData(0, 0, w, h).data
  const pixels: number[] = []
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (data[(y * w + x) * 4 + 3] > 128) pixels.push(x, y)
  const out = new Float32Array(count * 3)
  // 160px glyphs fill roughly 120px of the 220px canvas height.
  const scale = Math.min(maxW / (w - 40), maxH / 120)
  const m = pixels.length / 2
  for (let i = 0; i < count && m; i++) {
    const j = (Math.random() * m) | 0
    out[i * 3] = (pixels[j * 2] - w / 2 + Math.random() * 2) * scale
    out[i * 3 + 1] = (h / 2 - pixels[j * 2 + 1] + Math.random() * 2) * scale
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.04
  }
  return out
}

/** A loose disc the cloud gathers from on first show. */
function scatterPoints(count: number, width: number) {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random())
    out[i * 3] = Math.cos(a) * r * width * 0.6
    out[i * 3 + 1] = Math.sin(a) * r * 0.45
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.8
  }
  return out
}

export function createWordCloud(
  canvas: HTMLCanvasElement,
  { theme, count }: { theme: CloudTheme; count: number },
): WordCloud {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' })
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  // One world unit is the stage height: at z = 0 the view is exactly 1 unit tall.
  const fov = 30
  const depth = 0.5 / Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 20)
  camera.position.z = depth

  const geometry = new THREE.BufferGeometry()
  const from = new Float32Array(count * 3)
  const to = new Float32Array(count * 3)
  const rand = new Float32Array(count * 4)
  for (let i = 0; i < rand.length; i++) rand[i] = Math.random()
  geometry.setAttribute('position', new THREE.BufferAttribute(from, 3))
  geometry.setAttribute('aTo', new THREE.BufferAttribute(to, 3))
  geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10)

  const stagger = 0.45
  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: {
      uProgress: { value: 1 },
      uTime: { value: 0 },
      uSize: { value: 3 },
      uScatter: { value: 1 },
      uStagger: { value: stagger },
      uDepth: { value: depth },
      uWidth: { value: 1 },
      uAdditive: { value: 1 },
      uColA: { value: new THREE.Color() },
      uColB: { value: new THREE.Color() },
      uColC: { value: new THREE.Color() },
    },
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  const group = new THREE.Group()
  group.add(points)
  scene.add(group)

  const targetColors = [new THREE.Color(), new THREE.Color(), new THREE.Color()]
  let sizeBoost = 1
  function setTheme(next: CloudTheme) {
    const additive = next === 'dark'
    material.uniforms.uAdditive.value = additive ? 1 : 0
    // Ink on white needs slightly bigger dots than glow on black to read as solid.
    sizeBoost = additive ? 1 : 1.2
    material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    material.needsUpdate = true
    PALETTES[next].forEach((hex, i) => targetColors[i].set(hex))
  }
  setTheme(theme)
  ;(['uColA', 'uColB', 'uColC'] as const).forEach((key, i) =>
    (material.uniforms[key].value as THREE.Color).copy(targetColors[i]),
  )

  let width = 1
  let height = 1
  function resize() {
    const rect = canvas.getBoundingClientRect()
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    // Point size in device pixels, relative to the stage height.
    material.uniforms.uSize.value = Math.max(1.4, height * 0.0095) * dpr * sizeBoost
    material.uniforms.uWidth.value = (width / height) * 0.86
  }
  resize()
  const observer = new ResizeObserver(() => {
    resize()
    // Re-fit the word to the new width with a short settle instead of a jump.
    if (current) show(current, { duration: 0.8, scatter: 0.15 })
  })
  observer.observe(canvas)

  // Morph progress, driven by our own clock (seconds).
  let progress = 1
  let duration = 1
  let elapsedSinceMorph = 0
  let current = ''
  let first = true

  function show(text: string, opts: { duration?: number; scatter?: number } = {}) {
    const aspect = width / height
    const next = textPoints(text, count, aspect * 0.86, 0.62)
    if (first) {
      from.set(scatterPoints(count, aspect))
      first = false
    } else if (progress < 1) {
      // Bake the in-flight state into `from` so an interrupted morph continues smoothly.
      for (let i = 0; i < count; i++) {
        const k = Math.min(1, Math.max(0, (progress - rand[i * 4] * stagger) / (1 - stagger)))
        const e = ease(k)
        for (let c = 0; c < 3; c++) from[i * 3 + c] += (to[i * 3 + c] - from[i * 3 + c]) * e
      }
    } else {
      from.set(to)
    }
    to.set(next)
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aTo.needsUpdate = true
    material.uniforms.uScatter.value = opts.scatter ?? 1
    duration = opts.duration ?? 2.4
    elapsedSinceMorph = 0
    progress = 0
    current = text
    if (!running) renderOnce()
  }

  const pointer = new THREE.Vector2()
  function setPointer(x: number, y: number) {
    pointer.set(x, y)
  }

  const clock = new THREE.Clock()
  let raf = 0
  let running = false
  let time = 0

  function frame() {
    const dt = Math.min(clock.getDelta(), 1 / 20)
    time += dt
    elapsedSinceMorph += dt
    progress = Math.min(1, elapsedSinceMorph / duration)
    const u = material.uniforms
    u.uTime.value = time
    u.uProgress.value = progress
    const a = 1 - Math.exp(-dt * 3)
    ;(u.uColA.value as THREE.Color).lerp(targetColors[0], a)
    ;(u.uColB.value as THREE.Color).lerp(targetColors[1], a)
    ;(u.uColC.value as THREE.Color).lerp(targetColors[2], a)
    const damp = 1 - Math.exp(-dt * 2.5)
    group.rotation.y += (pointer.x * 0.28 - group.rotation.y) * damp
    group.rotation.x += (-pointer.y * 0.18 - group.rotation.x) * damp
    renderer.render(scene, camera)
    raf = requestAnimationFrame(frame)
  }

  function renderOnce() {
    const u = material.uniforms
    u.uProgress.value = 1
    ;(['uColA', 'uColB', 'uColC'] as const).forEach((key, i) => (u[key].value as THREE.Color).copy(targetColors[i]))
    renderer.render(scene, camera)
  }

  function setRunning(next: boolean) {
    if (next === running) return
    running = next
    if (running) {
      clock.getDelta()
      raf = requestAnimationFrame(frame)
    } else {
      cancelAnimationFrame(raf)
      if (progress >= 1) renderOnce()
    }
  }

  return {
    show,
    setTheme: (next) => {
      setTheme(next)
      resize()
      if (!running) renderOnce()
    },
    setPointer,
    setRunning,
    dispose: () => {
      setRunning(false)
      observer.disconnect()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    },
  }
}
