import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSite } from '../context'
import { REPO } from '../hooks'
import { Container, GitHubIcon, Logo, cx } from './ui'

const iconButton =
  'inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

export function Header({ onToggleLang, onToggleTheme }: { onToggleLang: () => void; onToggleTheme: () => void }) {
  const { t, theme } = useSite()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8)
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])

  const links = [
    ['#features', t.nav.features],
    ['#agent', t.nav.agent],
    ['#privacy', t.nav.privacy],
    ['#download', t.nav.download],
  ] as const

  return (
    <header
      className={cx(
        'sticky top-0 z-40 border-b transition-[background-color,border-color] duration-200',
        scrolled ? 'border-border bg-background/80 backdrop-blur-xl backdrop-saturate-150' : 'border-transparent',
      )}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-4 focus:rounded-md focus:bg-background focus:px-3 focus:py-1.5"
      >
        {t.ui.skip}
      </a>
      <Container className="flex h-16 items-center gap-6">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo className="size-7 rounded-[7px] dark:ring-1 dark:ring-white/15" />
          <span className="text-[17px]">FusionKit</span>
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {links.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleLang}
            className="h-9 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t.ui.language}
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className={iconButton}
            aria-label={theme === 'dark' ? t.ui.theme.light : t.ui.theme.dark}
            title={theme === 'dark' ? t.ui.theme.light : t.ui.theme.dark}
          >
            {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
          <a href={REPO} className={iconButton} aria-label={t.ui.github} title={t.ui.github}>
            <GitHubIcon className="size-[18px]" />
          </a>
        </div>
      </Container>
    </header>
  )
}
