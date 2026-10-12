import { useSite } from '../context'
import { cx } from './ui'

export type ShotName = 'studio' | 'agent' | 'dock' | 'tools'

// Pixel size of the README screenshots in docs/assets/readme.
const SIZES: Record<ShotName, [number, number]> = {
  studio: [2584, 1612],
  agent: [2584, 1372],
  dock: [2584, 1612],
  tools: [2584, 1612],
}

/**
 * A README screenshot in a window frame. `crop` keeps only a horizontal slice
 * of the image (fractions of its width), so a narrow column can still show the
 * interesting part at a readable size.
 */
export function Shot({
  name,
  alt,
  sizes,
  crop = [0, 1],
  priority = false,
  className,
}: {
  name: ShotName
  alt: string
  sizes: string
  crop?: [number, number]
  priority?: boolean
  className?: string
}) {
  const { lang, theme } = useSite()
  const [width, height] = SIZES[name]
  const visible = crop[1] - crop[0]
  const base = `/shots/${lang}/${name}-${theme}`

  return (
    <figure className={cx('shot overflow-hidden rounded-2xl border bg-card', className)}>
      <div className="flex h-9 items-center gap-1.5 border-b px-4" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
      </div>
      <div className="relative overflow-hidden" style={{ aspectRatio: `${width * visible} / ${height}` }}>
        <img
          key={base}
          src={`${base}-1280.webp`}
          srcSet={`${base}-1280.webp 1280w, ${base}-2400.webp 2400w`}
          sizes={sizes}
          alt={alt}
          width={width}
          height={height}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          className="absolute top-0 h-full max-w-none"
          style={{ width: `${100 / visible}%`, left: `${(-crop[0] / visible) * 100}%` }}
        />
      </div>
    </figure>
  )
}
