import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useSite } from '../context'
import type { WordCloud } from './wordCloud'

// "Subtitles" in a few languages. The same particles re-form each word, which is
// the whole product in one picture: one subtitle, another language.
const WORDS = [
  { text: '字幕', label: '中文', lang: 'zh' },
  { text: 'Subtitles', label: 'English', lang: 'en' },
  { text: '자막', label: '한국어', lang: 'ko' },
  { text: 'Sous-titres', label: 'Français', lang: 'fr' },
  { text: 'Untertitel', label: 'Deutsch', lang: 'de' },
  { text: 'Subtítulos', label: 'Español', lang: 'es' },
] as const

const INTERVAL = 5200

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function WordMorph() {
  const { lang, theme } = useSite()
  const reduced = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cloudRef = useRef<WordCloud | null>(null)
  const [index, setIndex] = useState(() => (lang === 'zh' ? 0 : 1))
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(true)
  const word = WORDS[index]
  // The label follows once the particles have mostly re-formed, not when they set off.
  const [labelIndex, setLabelIndex] = useState(index)
  useEffect(() => {
    const id = window.setTimeout(() => setLabelIndex(index), ready && !reduced ? 1100 : 0)
    return () => window.clearTimeout(id)
  }, [index, ready, reduced])
  const label = WORDS[labelIndex].label

  // Build the scene once; three.js is fetched only now, after first paint.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!supportsWebGL()) {
      setFailed(true)
      return
    }
    let disposed = false
    const count = window.innerWidth < 640 ? 9000 : 18000
    Promise.all([import('./wordCloud'), document.fonts?.ready])
      .then(([{ createWordCloud }]) => {
        if (disposed) return
        const cloud = createWordCloud(canvas, { theme, count })
        cloudRef.current = cloud
        setReady(true)
      })
      .catch(() => setFailed(true))
    return () => {
      disposed = true
      cloudRef.current?.dispose()
      cloudRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    cloudRef.current?.setTheme(theme)
  }, [theme, ready])

  // Re-form the current word whenever it changes (the first call gathers the cloud).
  useEffect(() => {
    if (!ready) return
    const fonts = document.fonts
    const text = word.text
    // Hangul and accented glyphs may come from fonts that load on first use.
    ;(fonts ? fonts.load(`600 160px "Inter Variable"`, text).catch(() => undefined) : Promise.resolve()).then(() =>
      cloudRef.current?.show(text, { duration: 2.2, scatter: 1 }),
    )
  }, [ready, word.text])

  // Only animate while the stage is on screen, the tab is visible and motion is welcome.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.05 })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const animating = ready && visible && pageVisible && !reduced
  useEffect(() => {
    cloudRef.current?.setRunning(animating)
  }, [animating])

  useEffect(() => {
    if (!animating) return
    const id = window.setInterval(() => setIndex((i) => (i + 1) % WORDS.length), INTERVAL)
    return () => window.clearInterval(id)
  }, [animating])

  // Gentle tilt towards the pointer, anywhere over the hero.
  useEffect(() => {
    if (!animating || !matchMedia('(hover: hover)').matches) return
    const move = (event: PointerEvent) => {
      cloudRef.current?.setPointer((event.clientX / innerWidth) * 2 - 1, (event.clientY / innerHeight) * 2 - 1)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [animating])

  return (
    <div ref={stageRef} className="relative mx-auto w-full max-w-4xl" aria-hidden="true">
      <div className="relative h-[clamp(132px,24vw,240px)]">
        {failed ? (
          <p
            lang={word.lang}
            className="word-fallback absolute inset-0 flex items-center justify-center text-[clamp(56px,11vw,128px)] font-semibold tracking-tight"
          >
            {word.text}
          </p>
        ) : (
          <motion.canvas
            ref={canvasRef}
            className="absolute inset-0 size-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: ready ? 1 : 0 }}
            transition={{ duration: 0.6 }}
          />
        )}
      </div>
      <div className="mt-1 flex h-7 items-center justify-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={label}
            className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur"
            initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.5 }}
          >
            <span className="size-1.5 rounded-full bg-studio" />
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  )
}
