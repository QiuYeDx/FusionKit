import { useSite } from '../context'
import { REPO } from '../hooks'
import { Container, Logo } from './ui'

export function Footer() {
  const { t } = useSite()
  const links = [
    [`${REPO}/releases`, t.footer.links.releases],
    [`${REPO}/blob/main/CHANGELOG.md`, t.footer.links.changelog],
    [`${REPO}/issues`, t.footer.links.issues],
    [REPO, t.footer.links.source],
  ] as const

  return (
    <footer className="border-t">
      <Container className="flex flex-col gap-8 py-12 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Logo className="size-8 rounded-[8px] dark:ring-1 dark:ring-white/15" />
          <div>
            <p className="font-semibold tracking-tight">FusionKit</p>
            <p className="text-sm text-muted-foreground">{t.footer.tagline}</p>
          </div>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground" aria-label="Footer">
          {links.map(([href, label]) => (
            <a key={label} href={href} className="hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
      </Container>
      <Container>
        <div className="flex flex-col gap-2 border-t py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <a href={`${REPO}/blob/main/LICENSE`} className="hover:text-foreground">
            {t.footer.license}
          </a>
          <a href="https://qiuvision.com" className="hover:text-foreground">
            {t.footer.madeBy}
          </a>
        </div>
      </Container>
    </footer>
  )
}
