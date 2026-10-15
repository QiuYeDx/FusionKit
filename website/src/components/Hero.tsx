import { ArrowRight, Download } from 'lucide-react'
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type Variants } from 'motion/react'
import { useRef } from 'react'
import { useSite } from '../context'
import { WordMorph } from '../hero/WordMorph'
import { REPO, detectPlatform, useLatestRelease } from '../hooks'
import { Shot } from './Shot'
import { Container, EASE, GitHubIcon, Phrases } from './ui'

const platform = detectPlatform()

const intro: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
}

const rise: Variants = {
  hidden: { opacity: 0, y: 14, filter: 'blur(6px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.7, ease: EASE } },
}

export function Hero() {
  const { t } = useSite()
  const release = useLatestRelease()
  const asset =
    release.status === 'ready' && platform !== 'other' ? release.release.assets[platform] : undefined
  const downloadHref = asset ?? (platform === 'other' ? '#download' : `${REPO}/releases/latest`)

  return (
    <section id="top" className="relative isolate overflow-hidden" aria-labelledby="hero-title">
      <div className="hero-grid absolute inset-0 -z-10" aria-hidden="true" />
      <div className="hero-glow absolute inset-0 -z-10" aria-hidden="true" />
      <Container className="pt-10 pb-20 sm:pt-14 lg:pt-16">
        <motion.div className="mx-auto max-w-5xl text-center" variants={intro} initial="hidden" animate="show">
          <motion.a
            variants={rise}
            href={`${REPO}/blob/main/CHANGELOG.md`}
            className="group inline-flex max-w-full items-center gap-2 rounded-full border bg-background/70 py-1 pr-3 pl-1 text-left text-xs text-muted-foreground backdrop-blur transition-colors hover:text-foreground sm:text-sm"
          >
            <span className="shrink-0 rounded-full bg-studio-soft px-2 py-0.5 font-medium text-studio">0.5.0</span>
            <span className="min-w-0">{t.hero.notice}</span>
            <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </motion.a>

          <motion.div variants={rise} className="mt-6 sm:mt-8">
            <WordMorph />
          </motion.div>

          <motion.h1
            variants={rise}
            id="hero-title"
            className="display mt-6 text-[2.25rem] font-semibold text-balance sm:mt-8 sm:text-5xl lg:text-6xl"
          >
            <Phrases text={t.hero.title} />
          </motion.h1>
          <motion.p
            variants={rise}
            className="mx-auto mt-5 max-w-xl text-base leading-7 text-balance [word-break:keep-all] text-muted-foreground sm:text-lg sm:leading-8"
          >
            {t.hero.subtitle}
          </motion.p>
          <motion.div variants={rise} className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href={downloadHref} className="btn btn-primary group w-full sm:w-auto">
              <Download className="size-4 transition-transform group-hover:translate-y-px" aria-hidden="true" />
              {t.hero.download[platform]}
            </a>
            <a href={REPO} className="btn btn-secondary w-full sm:w-auto">
              <GitHubIcon className="size-4" />
              {t.hero.source}
            </a>
          </motion.div>
          <motion.ul
            variants={rise}
            className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:text-sm"
          >
            {t.hero.meta.map((item, index) => (
              <li key={item} className="flex items-center gap-3">
                {index > 0 && <span className="size-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />}
                {item}
              </li>
            ))}
          </motion.ul>
        </motion.div>

        <HeroShot alt={t.hero.shotAlt} />
      </Container>
    </section>
  )
}

/** The Studio screenshot leans back in perspective and settles flat as it scrolls into view. */
function HeroShot({ alt }: { alt: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] })
  const progress = useSpring(scrollYProgress, { stiffness: 260, damping: 40, mass: 0.6 })
  const rotateX = useTransform(progress, [0, 1], [18, 0])
  const scale = useTransform(progress, [0, 1], [0.9, 1])
  const y = useTransform(progress, [0, 1], [40, 0])

  return (
    <motion.div
      ref={ref}
      className="relative mx-auto mt-14 max-w-5xl sm:mt-16"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, ease: EASE, delay: 0.45 }}
      style={{ perspective: 1600 }}
    >
      <div className="shot-halo absolute -inset-x-10 -top-10 -bottom-4 -z-10" aria-hidden="true" />
      <motion.div
        style={reduced ? undefined : { rotateX, scale, y, transformOrigin: '50% 0%' }}
        className="will-change-transform"
      >
        <Shot name="studio" alt={alt} sizes="(min-width: 1024px) 1024px, 100vw" priority />
      </motion.div>
    </motion.div>
  )
}
