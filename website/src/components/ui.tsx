import { motion, useReducedMotion, useScroll, useTransform, type Variants } from 'motion/react'
import { useRef, type PointerEvent, type ReactNode } from 'react'

export const EASE = [0.22, 1, 0.36, 1] as const

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>
}

const VIEWPORT = { once: true, margin: '0px 0px -80px 0px' } as const

export function Reveal({
  className,
  children,
  delay = 0,
  as = 'div',
}: {
  className?: string
  children: ReactNode
  delay?: number
  as?: 'div' | 'li'
}) {
  const Component = as === 'li' ? motion.li : motion.div
  return (
    <Component
      className={className}
      initial={{ opacity: 0, y: 20, filter: 'blur(6px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={VIEWPORT}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </Component>
  )
}

const group: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.07 } } }
export const item: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
}

/** Reveals its `motion.*` children (with `variants={item}`) one after another as it scrolls into view. */
export function Stagger({
  className,
  children,
  as = 'div',
  delay = 0,
}: {
  className?: string
  children: ReactNode
  as?: 'div' | 'ul' | 'ol' | 'dl'
  delay?: number
}) {
  const Component = { div: motion.div, ul: motion.ul, ol: motion.ol, dl: motion.dl }[as]
  return (
    <Component
      className={className}
      variants={delay ? { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: delay } } } : group}
      initial="hidden"
      whileInView="show"
      viewport={VIEWPORT}
    >
      {children}
    </Component>
  )
}

/** Drifts its content slightly against the scroll, so screenshots sit a little deeper than the text. */
export function Parallax({ children, className, distance = 32 }: { children: ReactNode; className?: string; distance?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance])
  return (
    <motion.div ref={ref} className={className} style={reduced ? undefined : { y }}>
      {children}
    </motion.div>
  )
}

/** Tracks the pointer in CSS variables so `.spotlight` cards can light up under it. */
export function trackSpotlight(event: PointerEvent<HTMLElement>) {
  const el = event.currentTarget
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--x', `${event.clientX - rect.left}px`)
  el.style.setProperty('--y', `${event.clientY - rect.top}px`)
}

export function SectionHeading({
  kicker,
  title,
  body,
  tone = 'neutral',
  align = 'left',
  id,
}: {
  kicker: string
  title: string
  body?: string
  tone?: 'neutral' | 'studio' | 'knowledge'
  align?: 'left' | 'center'
  id?: string
}) {
  const toneClass = { neutral: 'text-muted-foreground', studio: 'text-studio', knowledge: 'text-knowledge' }[tone]
  return (
    <div className={cx('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      <p className={cx('text-sm font-semibold', toneClass)}>{kicker}</p>
      <h2 id={id} className="display mt-3 text-3xl font-semibold text-balance sm:text-5xl">
        {title}
      </h2>
      {body && <p className="mt-5 text-base leading-7 text-balance text-muted-foreground sm:text-lg sm:leading-8">{body}</p>}
    </div>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <rect width="512" height="512" rx="116" fill="#0b0b0c" />
      <rect x="128" y="124" width="196" height="196" rx="38" fill="#a1a1aa" />
      <rect x="188" y="190" width="196" height="196" rx="38" fill="#ffffff" />
    </svg>
  )
}

export function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

/**
 * Renders a headline whose zero-width-space hints (see content.ts) mark the phrases:
 * each phrase stays on one line when it fits, so lines only break between phrases.
 */
export function Phrases({ text }: { text: string }) {
  const parts = text.split('\u200b')
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          <span className="inline-block">{part.trimEnd()}</span>
          {index < parts.length - 1 && part !== part.trimEnd() ? ' ' : ''}
        </span>
      ))}
    </>
  )
}
