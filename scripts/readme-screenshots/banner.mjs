// Renders the README banners (docs/assets/readme/<lang>/banner-<theme>.png) from HTML,
// using the Subtitle Studio screenshots that capture.mjs wrote. Run capture.mjs first.
//
//   node scripts/readme-screenshots/banner.mjs
//
// Rendering goes through the project's own Electron (render-window.cjs), so no extra browser download is needed.
import { _electron as electron } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const WIDTH = 1280;
const HEIGHT = 440;
const SCALE = 2;

const COPY = {
  zh: {
    tagline: 'AI 驱动的字幕与翻译桌面工具集',
    detail: '本地转写音视频，AI 翻译与修订字幕，用对话完成整套流程。',
    tags: ['字幕工作台', '本地转写', 'AI 翻译', 'Agent', '翻译资料'],
  },
  en: {
    tagline: 'AI-powered desktop toolkit for subtitles',
    detail: 'Transcribe media on your device, translate and revise subtitles with AI, or just ask the Agent.',
    tags: ['Subtitle Studio', 'Local transcription', 'AI translation', 'Agent'],
  },
};

const THEME = {
  light: {
    bg: '#f7f7f8', text: '#0a0a0b', muted: '#52525b', grid: 'rgba(10,10,11,0.06)',
    glowA: 'rgba(20,184,166,0.20)', glowB: 'rgba(139,92,246,0.16)',
    tagBg: 'rgba(255,255,255,0.8)', tagBorder: 'rgba(10,10,11,0.10)',
    frame: '#ffffff', frameBorder: 'rgba(10,10,11,0.10)', bar: '#f4f4f5', iconRing: 'transparent', shadow: '0 30px 80px -20px rgba(15,23,42,0.28), 0 8px 24px -8px rgba(15,23,42,0.12)',
  },
  dark: {
    bg: '#09090b', text: '#fafafa', muted: '#a1a1aa', grid: 'rgba(255,255,255,0.05)',
    glowA: 'rgba(20,184,166,0.22)', glowB: 'rgba(139,92,246,0.20)',
    tagBg: 'rgba(255,255,255,0.04)', tagBorder: 'rgba(255,255,255,0.12)',
    frame: '#0a0a0a', frameBorder: 'rgba(255,255,255,0.12)', bar: '#141416', iconRing: 'rgba(255,255,255,0.14)', shadow: '0 30px 80px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)',
  },
};

const icon = `<svg viewBox="0 0 512 512" width="64" height="64" aria-hidden="true">
  <rect width="512" height="512" rx="112" fill="#0b0b0c"/>
  <rect x="128" y="124" width="196" height="196" rx="30" fill="#a1a1aa"/>
  <rect x="188" y="190" width="196" height="196" rx="30" fill="#ffffff"/>
</svg>`;

function html(lang, theme, screenshot) {
  const c = COPY[lang];
  const t = THEME[theme];
  const font = lang === 'zh'
    ? `"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif`
    : `"Segoe UI Variable Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html { zoom: ${SCALE}; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    font-family: ${font}; color: ${t.text}; background: ${t.bg};
    position: relative; -webkit-font-smoothing: antialiased;
  }
  .grid {
    position: absolute; inset: 0;
    background-image: linear-gradient(${t.grid} 1px, transparent 1px), linear-gradient(90deg, ${t.grid} 1px, transparent 1px);
    background-size: 32px 32px;
    mask-image: radial-gradient(ellipse 70% 90% at 30% 50%, #000 30%, transparent 85%);
  }
  .glow { position: absolute; border-radius: 50%; filter: blur(70px); }
  .glow.a { width: 520px; height: 360px; left: 520px; top: 40px; background: ${t.glowA}; }
  .glow.b { width: 460px; height: 340px; right: -80px; top: 160px; background: ${t.glowB}; }
  .copy { position: absolute; left: 72px; top: 0; bottom: 0; width: 560px; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand svg { border-radius: 14px; box-shadow: 0 0 0 1px ${t.iconRing}, 0 10px 30px -10px rgba(0,0,0,0.45); flex: none; }
  h1 { font-size: 58px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .tagline { margin-top: 26px; font-size: 27px; font-weight: 600; letter-spacing: ${lang === 'zh' ? '0.01em' : '-0.01em'}; line-height: 1.3; }
  .detail { margin-top: 10px; font-size: 16px; color: ${t.muted}; line-height: 1.55; max-width: 500px; }
  .tags { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 8px; }
  .tags span { font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid ${t.tagBorder}; background: ${t.tagBg}; color: ${t.text}; font-weight: 500; }
  .window {
    position: absolute; left: 676px; top: 62px; width: 760px;
    border-radius: 14px; overflow: hidden; background: ${t.frame};
    border: 1px solid ${t.frameBorder}; box-shadow: ${t.shadow};
  }
  .bar { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 12px; background: ${t.bar}; border-bottom: 1px solid ${t.frameBorder}; }
  .bar i { width: 10px; height: 10px; border-radius: 50%; display: block; }
  .window img { display: block; width: 100%; }
  </style></head><body>
  <div class="grid"></div><div class="glow a"></div><div class="glow b"></div>
  <div class="copy">
    <div class="brand">${icon}<h1>FusionKit</h1></div>
    <p class="tagline">${c.tagline}</p>
    <p class="detail">${c.detail}</p>
    <div class="tags">${c.tags.map((tag) => `<span>${tag}</span>`).join('')}</div>
  </div>
  <div class="window">
    <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
    <img src="data:image/png;base64,${screenshot}">
  </div>
  </body></html>`;
}

const app = await electron.launch({ args: [path.resolve('scripts/readme-screenshots/render-window.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: WIDTH * SCALE, height: HEIGHT * SCALE });
  for (const lang of Object.keys(COPY)) {
    for (const theme of Object.keys(THEME)) {
      const dir = path.resolve('docs/assets/readme', lang);
      const screenshot = (await readFile(path.join(dir, `studio-${theme}.png`))).toString('base64');
      await page.setContent(html(lang, theme, screenshot), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(dir, `banner-${theme}.png`) });
      console.log(`wrote ${lang}/banner-${theme}.png`);
    }
  }
} finally {
  await app.close();
}
