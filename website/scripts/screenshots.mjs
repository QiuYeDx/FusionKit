// Converts the README screenshots (docs/assets/readme, regenerated from the
// real app by scripts/readme-screenshots) into WebP files the site serves, so
// the site never keeps its own copies that drift from the README.
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(here, '../../docs/assets/readme')
const target = path.resolve(here, '../public/shots')
const widths = [1280, 2400]

async function isFresh(input, output) {
  try {
    return (await stat(output)).mtimeMs >= (await stat(input)).mtimeMs
  } catch {
    return false
  }
}

let written = 0
for (const lang of ['zh', 'en']) {
  const dir = path.join(source, lang)
  await mkdir(path.join(target, lang), { recursive: true })
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.png')) continue
    const input = path.join(dir, file)
    const name = file.replace(/\.png$/, '')
    for (const width of widths) {
      const output = path.join(target, lang, `${name}-${width}.webp`)
      if (await isFresh(input, output)) continue
      await sharp(input)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82, effort: 5 })
        .toFile(output)
      written += 1
    }
  }
}

// The banner doubles as the social preview image.
for (const lang of ['zh', 'en']) {
  const input = path.join(source, lang, 'banner-light.png')
  const output = path.join(target, `og-${lang}.png`)
  if (await isFresh(input, output)) continue
  await sharp(input)
    .resize({ width: 1200, height: 630, fit: 'cover', position: 'left' })
    .png({ compressionLevel: 9 })
    .toFile(output)
  written += 1
}

console.log(`screenshots: ${written} file(s) written to public/shots`)
