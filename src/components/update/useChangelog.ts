import { useCallback, useEffect, useState } from 'react'
import { changelogUrls } from '@/app-update/contract'
import type { DownloadSourceMode } from '@/network/contract'

/** Each address gets this long before the next one is tried. */
const CHANGELOG_TIMEOUT_MS = 8_000
/** CHANGELOG.md once fetched in this session, by address list: reopening the dialog does not wait again. */
const changelogCache = new Map<string, string>()

export interface ChangelogSection {
  title?: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  date: string
  sections: ChangelogSection[]
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na !== nb) return na - nb
  }
  return 0
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const versionRegex = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(.+)$/
  const sectionRegex = /^### (.+)$/

  const lines = markdown.split(/\r?\n/)
  let currentEntry: ChangelogEntry | null = null
  let currentSection: ChangelogSection | null = null

  for (const line of lines) {
    const versionMatch = line.match(versionRegex)
    if (versionMatch) {
      if (currentSection?.items.length && currentEntry) {
        currentEntry.sections.push(currentSection)
      }
      if (currentEntry) {
        entries.push(currentEntry)
      }
      currentEntry = {
        version: versionMatch[1],
        date: versionMatch[2].trim(),
        sections: [],
      }
      currentSection = { items: [] }
      continue
    }

    if (!currentEntry) continue

    const sectionMatch = line.match(sectionRegex)
    if (sectionMatch) {
      if (currentSection?.items.length) {
        currentEntry.sections.push(currentSection)
      }
      currentSection = { title: sectionMatch[1], items: [] }
      continue
    }

    const itemMatch = line.match(/^- (.+)$/)
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1])
    }
  }

  if (currentSection?.items.length && currentEntry) {
    currentEntry.sections.push(currentSection)
  }
  if (currentEntry) {
    entries.push(currentEntry)
  }

  return entries
}

/** The entries after currentVersion, up to and including newVersion. */
export function changelogBetween(entries: readonly ChangelogEntry[], currentVersion: string, newVersion: string): ChangelogEntry[] {
  return entries.filter(e =>
    compareVersions(e.version, currentVersion) > 0 &&
    compareVersions(e.version, newVersion) <= 0
  )
}

/**
 * CHANGELOG.md from the first address that answers: raw.githubusercontent.com and its mirrors
 * (jsDelivr, ghfast), in the download-source setting's order, each with its own time limit. The
 * request goes through Chromium, which follows the proxy setting. A page that is not the
 * changelog (a mirror's error page) counts as no answer.
 */
export async function fetchChangelogMarkdown(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHANGELOG_TIMEOUT_MS,
): Promise<string> {
  let lastError: unknown = new Error('No changelog address')
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (!/^## \[\d+\.\d+\.\d+\]/m.test(text)) throw new Error('Not the changelog')
      return text
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/**
 * Fetches CHANGELOG.md and extracts entries
 * between currentVersion (exclusive) and newVersion (inclusive).
 */
export function useChangelog(currentVersion?: string, newVersion?: string, enabled = false, mode: DownloadSourceMode = 'auto') {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const fetchChangelog = useCallback(async (isCurrent: () => boolean) => {
    if (!currentVersion || !newVersion) return

    const urls = changelogUrls(mode)
    const cacheKey = urls.join(' ')
    const cached = changelogCache.get(cacheKey)
    if (cached !== undefined) {
      setError(undefined)
      setEntries(changelogBetween(parseChangelog(cached), currentVersion, newVersion))
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const text = await fetchChangelogMarkdown(urls)
      changelogCache.set(cacheKey, text)
      if (isCurrent()) setEntries(changelogBetween(parseChangelog(text), currentVersion, newVersion))
    } catch (err) {
      if (isCurrent()) setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [currentVersion, newVersion, mode])

  useEffect(() => {
    let current = true
    if (enabled) {
      void fetchChangelog(() => current)
    } else {
      setEntries([])
      setError(undefined)
    }
    return () => { current = false }
  }, [enabled, fetchChangelog])

  return { entries, loading, error }
}
