import { useCallback, useEffect, useState } from 'react'
import type { Lang } from './content'

export const REPO = 'https://github.com/QiuYeDx/FusionKit'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows and blocked storage just lose the preference.
  }
}

function initialLang(): Lang {
  const fromQuery = new URLSearchParams(location.search).get('lang')
  if (fromQuery === 'zh' || fromQuery === 'en') return fromQuery
  const stored = readStored('fk-lang')
  if (stored === 'zh' || stored === 'en') return stored
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function useLang() {
  const [lang, setLang] = useState<Lang>(initialLang)
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])
  const toggle = useCallback(() => {
    setLang((current) => {
      const next = current === 'zh' ? 'en' : 'zh'
      writeStored('fk-lang', next)
      const url = new URL(location.href)
      url.searchParams.set('lang', next)
      history.replaceState(null, '', url)
      return next
    })
  }, [])
  return [lang, toggle] as const
}

export type Theme = 'light' | 'dark'

const darkQuery = '(prefers-color-scheme: dark)'

export function useTheme() {
  // index.html sets the class before first paint; start from what it decided.
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const media = matchMedia(darkQuery)
    const follow = (event: MediaQueryListEvent) => {
      if (!readStored('fk-theme')) setTheme(event.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      // Going back to what the system prefers means following the system again.
      if ((next === 'dark') === matchMedia(darkQuery).matches) {
        try {
          localStorage.removeItem('fk-theme')
        } catch {
          // ignore
        }
      } else {
        writeStored('fk-theme', next)
      }
      return next
    })
  }, [])

  return [theme, toggle] as const
}

export type Platform = 'mac' | 'windows' | 'other'

export function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (/iPhone|iPad|Android/i.test(ua)) return 'other'
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  return 'other'
}

export type Release = {
  version: string
  url: string
  assets: { mac?: string; windows?: string }
}

type ReleaseState = { status: 'loading' } | { status: 'ready'; release: Release } | { status: 'error' }

let pending: Promise<Release> | null = null

function fetchLatest(): Promise<Release> {
  pending ??= fetch('https://api.github.com/repos/QiuYeDx/FusionKit/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      return response.json()
    })
    .then((data: { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] }) => {
      const find = (pattern: RegExp) => data.assets.find((asset) => pattern.test(asset.name))?.browser_download_url
      return {
        version: data.tag_name,
        url: data.html_url,
        assets: { mac: find(/arm64\.dmg$/i) ?? find(/\.dmg$/i), windows: find(/\.exe$/i) },
      }
    })
  return pending
}

export function useLatestRelease(): ReleaseState {
  const [state, setState] = useState<ReleaseState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    fetchLatest().then(
      (release) => active && setState({ status: 'ready', release }),
      () => active && setState({ status: 'error' }),
    )
    return () => {
      active = false
    }
  }, [])
  return state
}
