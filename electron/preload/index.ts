import { ipcRenderer, contextBridge, webUtils } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

// --------- Expose webUtils API for file path access ---------
// From Electron 24+, use webUtils.getPathForFile() instead of File.path
contextBridge.exposeInMainWorld('electronUtils', {
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * Preload loading screen — matches FusionKit's visual identity.
 * Detects theme from localStorage / system preference so the background
 * color is correct from the very first frame.
 */
function useLoading() {
  type ThemeValue = 'light' | 'dark' | 'system'

  // Keep this in sync with the persisted theme store in src/store/useThemeStore.ts.
  const getSavedTheme = (): ThemeValue | null => {
    if (typeof localStorage === 'undefined') return null

    try {
      const persistedTheme = localStorage.getItem('fusionkit-theme')
      if (persistedTheme) {
        const theme = JSON.parse(persistedTheme)?.state?.theme
        if (theme === 'light' || theme === 'dark' || theme === 'system') {
          return theme
        }
      }
    } catch {
      // Fall back to the legacy value or the system preference.
    }

    const legacyTheme = localStorage.getItem('theme')
    return legacyTheme === 'light' || legacyTheme === 'dark' || legacyTheme === 'system'
      ? legacyTheme
      : null
  }

  const savedTheme = getSavedTheme()

  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches

  const isDark =
    savedTheme === 'dark' ||
    ((!savedTheme || savedTheme === 'system') && prefersDark)

  const palette = isDark
    ? {
        background: '#1b1b1f',
        foreground: '#fafafa',
        muted: '#a1a1aa',
        line: 'rgba(255,255,255,0.09)',
        lineStrong: 'rgba(255,255,255,0.16)',
        tileBack: '#71717a',
        tileFront: '#f4f4f5',
        tileFrontHighlight: 'rgba(255,255,255,0.9)',
        tileShadow: 'rgba(0,0,0,0.34)',
        glowViolet: 'rgba(139,92,246,0.15)',
        glowBlue: 'rgba(56,189,248,0.11)',
        meterIdle: 'rgba(255,255,255,0.12)',
        meterActive: 'rgba(255,255,255,0.8)',
      }
    : {
        background: '#fafafa',
        foreground: '#18181b',
        muted: '#71717a',
        line: 'rgba(9,9,11,0.07)',
        lineStrong: 'rgba(9,9,11,0.13)',
        tileBack: '#a1a1aa',
        tileFront: '#18181b',
        tileFrontHighlight: 'rgba(255,255,255,0.2)',
        tileShadow: 'rgba(9,9,11,0.16)',
        glowViolet: 'rgba(124,58,237,0.09)',
        glowBlue: 'rgba(2,132,199,0.07)',
        meterIdle: 'rgba(9,9,11,0.1)',
        meterActive: 'rgba(9,9,11,0.72)',
      }

  const styleContent = `
/* ---------- Preload Loading Screen ---------- */

@keyframes fk-content-enter {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes fk-ambient-drift-a {
  0%, 100% { transform: translate3d(-5%, -3%, 0) scale(1); opacity: 0.72; }
  50%      { transform: translate3d(4%, 5%, 0) scale(1.12); opacity: 1; }
}

@keyframes fk-ambient-drift-b {
  0%, 100% { transform: translate3d(4%, 3%, 0) scale(1.08); opacity: 0.85; }
  50%      { transform: translate3d(-4%, -5%, 0) scale(0.96); opacity: 0.58; }
}

@keyframes fk-orbit {
  to { transform: rotate(360deg); }
}

@keyframes fk-orbit-reverse {
  to { transform: rotate(-360deg); }
}

@keyframes fk-tile-back {
  0%, 100% { transform: translate3d(-12px, -11px, 0) rotate(-3deg); }
  50%      { transform: translate3d(-16px, -15px, 0) rotate(-7deg); }
}

@keyframes fk-tile-front {
  0%, 100% { transform: translate3d(12px, 13px, 0) rotate(0deg); }
  50%      { transform: translate3d(15px, 16px, 0) rotate(3deg); }
}

@keyframes fk-core-pulse {
  0%, 100% { transform: scale(0.65); opacity: 0; }
  42%      { transform: scale(1); opacity: 0.8; }
  72%      { transform: scale(1.35); opacity: 0; }
}

@keyframes fk-meter {
  0%, 18%, 100% { transform: scaleX(0.45); background: ${palette.meterIdle}; }
  42%, 70%      { transform: scaleX(1); background: ${palette.meterActive}; }
}

.app-loading-wrap {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: ${palette.background};
  z-index: 2147483647;
  -webkit-app-region: drag;
  user-select: none;
  isolation: isolate;
  transition: opacity 0.48s cubic-bezier(0.4, 0, 0.2, 1);
}

.app-loading-wrap.fk-fade-out {
  opacity: 0;
  pointer-events: none;
}

.app-loading-wrap.fk-fade-out .fk-loading-content {
  transform: translateY(-4px) scale(0.985);
  opacity: 0;
}

.fk-ambient {
  position: absolute;
  width: min(68vw, 720px);
  aspect-ratio: 1;
  border-radius: 50%;
  pointer-events: none;
  filter: blur(2px);
  opacity: 0.8;
}

.fk-ambient-a {
  top: -42%;
  left: -14%;
  background: radial-gradient(circle, ${palette.glowViolet} 0%, transparent 68%);
  animation: fk-ambient-drift-a 7s ease-in-out infinite;
}

.fk-ambient-b {
  right: -18%;
  bottom: -48%;
  background: radial-gradient(circle, ${palette.glowBlue} 0%, transparent 68%);
  animation: fk-ambient-drift-b 8.5s ease-in-out infinite;
}

.fk-loading-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  transform-origin: center;
  transition:
    transform 0.48s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.32s ease;
  animation: fk-content-enter 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.fk-mark-stage {
  position: relative;
  width: 120px;
  height: 120px;
  display: grid;
  place-items: center;
  filter: drop-shadow(0 18px 24px ${palette.tileShadow});
}

.fk-orbit {
  position: absolute;
  inset: 4px;
  border: 1px solid ${palette.line};
  border-radius: 50%;
  animation: fk-orbit 12s linear infinite;
}

.fk-orbit::before {
  content: '';
  position: absolute;
  top: -2px;
  left: 50%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: ${palette.foreground};
  box-shadow: 0 0 10px ${palette.foreground};
}

.fk-orbit-inner {
  position: absolute;
  inset: 20px;
  border: 1px dashed ${palette.lineStrong};
  border-radius: 50%;
  animation: fk-orbit-reverse 16s linear infinite;
}

.fk-tile {
  position: absolute;
  width: 52px;
  height: 52px;
  border-radius: 13px;
  will-change: transform;
}

.fk-tile::after {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: 12px;
  background: linear-gradient(145deg, ${palette.tileFrontHighlight}, transparent 42%);
  opacity: 0.45;
}

.fk-tile-back {
  background: ${palette.tileBack};
  animation: fk-tile-back 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.fk-tile-front {
  background: ${palette.tileFront};
  animation: fk-tile-front 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}

.fk-core {
  position: absolute;
  width: 12px;
  height: 12px;
  border: 1px solid ${palette.foreground};
  border-radius: 4px;
  animation: fk-core-pulse 3.2s ease-out infinite;
}

.fk-wordmark {
  margin-top: 28px;
  color: ${palette.foreground};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 17px;
  font-weight: 620;
  letter-spacing: -0.035em;
}

.fk-meter {
  display: flex;
  gap: 5px;
  margin-top: 15px;
}

.fk-meter span {
  width: 15px;
  height: 2px;
  border-radius: 999px;
  transform-origin: center;
  background: ${palette.meterIdle};
  animation: fk-meter 1.8s ease-in-out infinite;
}

.fk-meter span:nth-child(2) {
  animation-delay: 0.16s;
}

.fk-meter span:nth-child(3) {
  animation-delay: 0.32s;
}

.fk-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fk-ambient,
  .fk-orbit,
  .fk-orbit-inner,
  .fk-tile,
  .fk-core,
  .fk-meter span {
    animation: none;
  }

  .fk-tile-back {
    transform: translate3d(-13px, -12px, 0);
  }

  .fk-tile-front {
    transform: translate3d(13px, 14px, 0);
  }

  .fk-meter span {
    transform: scaleX(0.7);
    background: ${palette.meterActive};
  }
}
  `

  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')
  let isRemoving = false

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.setAttribute('role', 'status')
  oDiv.setAttribute('aria-live', 'polite')
  oDiv.innerHTML = `
    <div class="fk-ambient fk-ambient-a"></div>
    <div class="fk-ambient fk-ambient-b"></div>
    <div class="fk-loading-content" aria-hidden="true">
      <div class="fk-mark-stage">
        <div class="fk-orbit"></div>
        <div class="fk-orbit-inner"></div>
        <div class="fk-tile fk-tile-back"></div>
        <div class="fk-tile fk-tile-front"></div>
        <div class="fk-core"></div>
      </div>
      <div class="fk-wordmark">FusionKit</div>
      <div class="fk-meter"><span></span><span></span><span></span></div>
    </div>
    <span class="fk-sr-only">FusionKit is starting</span>
  `

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      if (isRemoving) return
      isRemoving = true
      oDiv.classList.add('fk-fade-out')
      setTimeout(() => {
        safeDOM.remove(document.head, oStyle)
        safeDOM.remove(document.body, oDiv)
      }, 500)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)
