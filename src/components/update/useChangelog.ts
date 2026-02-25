import { useCallback, useEffect, useState } from 'react'

const CHANGELOG_RAW_URL = 'https://raw.githubusercontent.com/QiuYeDx/FusionKit/main/CHANGELOG.md'

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

function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const versionRegex = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(.+)$/
  const sectionRegex = /^### (.+)$/

  const lines = markdown.split('\n')
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
    entries.push(currentEntry)
  }

  return entries
}

/**
 * Fetches CHANGELOG.md from GitHub and extracts entries
 * between currentVersion (exclusive) and newVersion (inclusive).
 */
export function useChangelog(currentVersion?: string, newVersion?: string, enabled = false) {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const fetchChangelog = useCallback(async () => {
    if (!currentVersion || !newVersion) return

    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch(CHANGELOG_RAW_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      const allEntries = parseChangelog(text)

      const relevant = allEntries.filter(e =>
        compareVersions(e.version, currentVersion) > 0 &&
        compareVersions(e.version, newVersion) <= 0
      )

      setEntries(relevant)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [currentVersion, newVersion])

  useEffect(() => {
    if (enabled) {
      void fetchChangelog()
    } else {
      setEntries([])
      setError(undefined)
    }
  }, [enabled, fetchChangelog])

  return { entries, loading, error }
}
