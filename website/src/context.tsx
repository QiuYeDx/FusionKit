import { createContext, useContext } from 'react'
import type { Content, Lang } from './content'
import type { Theme } from './hooks'

type Site = { lang: Lang; theme: Theme; t: Content }

export const SiteContext = createContext<Site | null>(null)

export function useSite(): Site {
  const site = useContext(SiteContext)
  if (!site) throw new Error('useSite outside SiteContext')
  return site
}
