# FusionKit website

The product page for FusionKit: a static Vite + React + Tailwind CSS 4 site,
deployed on Vercel from this folder.

```bash
cd website
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # outputs dist/
```

- **Content** lives in `src/content.ts`, in Simplified Chinese and English.
  Visitors get their browser language; `?lang=zh` / `?lang=en` forces one.
- **Screenshots** are not copied into this folder. `scripts/screenshots.mjs`
  (run by `dev` and `build`) converts the README screenshots in
  `../docs/assets/readme` to WebP under `public/shots/`, which is ignored by
  Git. Regenerate the README screenshots with `scripts/readme-screenshots` and
  the site picks them up on the next build.
- **Downloads** link straight to the installers of the latest GitHub release
  (looked up in the browser), falling back to the Releases page.
- **Hero particles** (`src/hero/`) re-form the word "subtitles" in several
  languages, adapted from the `particle-type` demo in motion-3d-lab. It is plain
  three.js in a lazily loaded chunk, pauses off screen and in background tabs,
  stays still for reduced motion, and falls back to text without WebGL.

## Deployment

The Vercel project uses `website` as its Root Directory and keeps "Include
files outside the root directory" on, because the build reads
`../docs/assets/readme`. `vercel.json` skips builds for commits that touch
neither this folder nor those screenshots. The site URL used in the Open Graph
tags is `VITE_SITE_URL` in `.env`.
