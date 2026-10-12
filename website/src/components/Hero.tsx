import { ArrowRight, Download } from 'lucide-react'
import { motion } from 'motion/react'
import { useSite } from '../context'
import { REPO, detectPlatform, useLatestRelease } from '../hooks'
import { Shot } from './Shot'
import { Container, GitHubIcon } from './ui'

const platform = detectPlatform()

export function Hero() {
  const { t } = useSite()
  const release = useLatestRelease()
  const asset =
    release.status === 'ready' && platform !== 'other' ? release.release.assets[platform] : undefined
  const downloadHref = asset ?? (platform === 'other' ? '#download' : `${REPO}/releases/latest`)
  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <section id="top" className="relative isolate overflow-hidden" aria-labelledby="hero-title">
      <div className="hero-grid absolute inset-0 -z-10" aria-hidden="true" />
      <div className="hero-glow absolute inset-0 -z-10" aria-hidden="true" />
      <Container className="pt-14 pb-20 sm:pt-20 lg:pt-24">
        <motion.div
          className="mx-auto max-w-5xl text-center"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease }}
        >
          <a
            href={`${REPO}/blob/main/CHANGELOG.md`}
            className="group inline-flex max-w-full items-center gap-2 rounded-full border bg-background/70 py-1 pr-3 pl-1 text-left text-xs text-muted-foreground backdrop-blur transition-colors hover:text-foreground sm:text-sm"
          >
            <span className="shrink-0 rounded-full bg-studio-soft px-2 py-0.5 font-medium text-studio">0.4.0</span>
            <span className="min-w-0">{t.hero.notice}</span>
            <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </a>
          <h1
            id="hero-title"
            className="mt-7 text-[2rem] leading-tight font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl lg:leading-[1.08]"
          >
            {t.hero.title}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg sm:leading-8">
            {t.hero.subtitle}
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={downloadHref}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
            >
              <Download className="size-4" aria-hidden="true" />
              {t.hero.download[platform]}
            </a>
            <a
              href={REPO}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border bg-background px-6 text-sm font-medium transition-colors hover:bg-muted sm:w-auto"
            >
              <GitHubIcon className="size-4" />
              {t.hero.source}
            </a>
          </div>
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            {t.hero.meta.map((item, index) => (
              <li key={item} className="flex items-center gap-3">
                {index > 0 && <span className="size-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />}
                {item}
              </li>
            ))}
          </ul>
        </motion.div>
        <motion.div
          className="mx-auto mt-14 max-w-5xl sm:mt-16"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease, delay: 0.12 }}
        >
          <Shot name="studio" alt={t.hero.shotAlt} sizes="(min-width: 1024px) 1024px, 100vw" priority />
        </motion.div>
      </Container>
    </section>
  )
}
