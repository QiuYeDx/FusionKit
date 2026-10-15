import { ArrowUpRight, Download as DownloadIcon, Laptop, Monitor } from 'lucide-react'
import { useSite } from '../context'
import { REPO, detectPlatform, useLatestRelease } from '../hooks'
import { motion } from 'motion/react'
import { Container, Reveal, SectionHeading, Stagger, cx, item, trackSpotlight } from './ui'

const platform = detectPlatform()

export function Download() {
  const { t } = useSite()
  const { download } = t
  const release = useLatestRelease()
  const status =
    release.status === 'ready'
      ? download.latest(release.release.version)
      : release.status === 'loading'
        ? download.loading
        : download.unavailable

  const cards = [
    { key: 'mac', Icon: Laptop, ...download.platforms.mac },
    { key: 'windows', Icon: Monitor, ...download.platforms.windows },
  ] as const

  return (
    <section id="download" data-nav="download" className="border-t bg-surface py-24 sm:py-32" aria-labelledby="download-title">
      <Container>
        <Reveal>
          <SectionHeading
            id="download-title"
            align="center"
            kicker={download.kicker}
            title={download.title}
            body={download.body}
          />
        </Reveal>

        <Reveal className="mx-auto mt-12 max-w-3xl" delay={0.06}>
          <div className="grid gap-4 sm:grid-cols-2">
            {cards.map(({ key, Icon, title, body, package: pkg }) => {
              const preferred = platform === key
              const href =
                (release.status === 'ready' && release.release.assets[key]) || `${REPO}/releases/latest`
              return (
                <div
                  key={key}
                  onPointerMove={trackSpotlight}
                  className={cx(
                    'spotlight flex flex-col rounded-2xl border bg-card p-6',
                    preferred && 'ring-1 ring-foreground/15',
                  )}
                >
                  <div className="flex items-start gap-4">
                    <Icon className="mt-0.5 size-6 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold">{title}</h3>
                      <p className="text-sm text-muted-foreground">{body}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{pkg}</p>
                    </div>
                  </div>
                  <a
                    href={href}
                    className={cx('btn mt-6 h-10', preferred ? 'btn-primary' : 'btn-secondary')}
                  >
                    <DownloadIcon className="size-4" aria-hidden="true" />
                    {download.button} {title}
                  </a>
                </div>
              )
            })}
          </div>
          <p className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span aria-live="polite">{status}</span>
            <span className="size-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />
            <a href={`${REPO}/releases`} className="inline-flex items-center gap-1 hover:text-foreground">
              {download.allReleases}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
          </p>
        </Reveal>

        <div className="mx-auto mt-20 max-w-5xl">
          <Reveal>
            <h3 className="text-center text-sm font-semibold text-muted-foreground">{download.stepsTitle}</h3>
          </Reveal>
          <Stagger as="ol" className="mt-6 grid gap-4 md:grid-cols-3">
            {download.steps.map((step, index) => (
              <motion.li key={step.title} variants={item} className="rounded-2xl border bg-card p-6">
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted font-mono text-xs tabular-nums">
                  {index + 1}
                </span>
                <h4 className="mt-4 font-semibold">{step.title}</h4>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.body}</p>
              </motion.li>
            ))}
          </Stagger>
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-5 text-balance text-muted-foreground">{download.note}</p>
        </div>
      </Container>
    </section>
  )
}
