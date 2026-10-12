import { motion } from 'motion/react'
import type { ReactNode } from 'react'

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>
}

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
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -80px 0px' }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </Component>
  )
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
      <h2 id={id} className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-base leading-7 text-balance text-muted-foreground sm:text-lg sm:leading-8">{body}</p>}
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
