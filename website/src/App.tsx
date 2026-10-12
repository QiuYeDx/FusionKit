import { MotionConfig } from 'motion/react'
import { useEffect, useMemo } from 'react'
import { Download } from './components/Download'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { Agent, Knowledge, Pillars, Privacy, Studio, Tools } from './components/Sections'
import { content } from './content'
import { SiteContext } from './context'
import { useLang, useTheme } from './hooks'

export function App() {
  const [lang, toggleLang] = useLang()
  const [theme, toggleTheme] = useTheme()
  const t = content[lang]
  const site = useMemo(() => ({ lang, theme, t }), [lang, theme, t])

  useEffect(() => {
    document.title = t.meta.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', t.meta.description)
  }, [t])

  return (
    <SiteContext.Provider value={site}>
      <MotionConfig reducedMotion="user">
        <Header onToggleLang={toggleLang} onToggleTheme={toggleTheme} />
        <main id="main">
          <Hero />
          <Pillars />
          <Studio />
          <Agent />
          <Knowledge />
          <Tools />
          <Privacy />
          <Download />
        </main>
        <Footer />
      </MotionConfig>
    </SiteContext.Provider>
  )
}
