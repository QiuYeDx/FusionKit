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
  // ---- Theme detection (mirrors src/utils/common.ts logic) ----
  const savedTheme = (typeof localStorage !== 'undefined'
    ? localStorage.getItem('theme')
    : null) as 'light' | 'dark' | 'system' | null

  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches

  const isDark =
    savedTheme === 'dark' ||
    ((!savedTheme || savedTheme === 'system') && prefersDark)

  // ---- Palette ----
  const bg        = isDark ? '#1b1b1f' : '#ffffff'
  const rectBack  = isDark ? '#a1a1aa' : '#a1a1aa'
  const rectFront = isDark ? '#ffffff' : '#09090b'
  const glowColor = isDark
    ? 'rgba(161,161,170,0.18)'
    : 'rgba(9,9,11,0.06)'
  const shimmer   = isDark
    ? 'rgba(255,255,255,0.04)'
    : 'rgba(0,0,0,0.025)'

  const styleContent = `
/* ---------- Preload Loading Screen ---------- */

@keyframes fk-breathe {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(1.06); opacity: 0.72; }
}

@keyframes fk-glow-pulse {
  0%, 100% { box-shadow: 0 0 0 0 ${glowColor}; }
  50%      { box-shadow: 0 0 28px 8px ${glowColor}; }
}

@keyframes fk-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes fk-fade-in {
  from { opacity: 0; transform: scale(0.88); }
  to   { opacity: 1; transform: scale(1); }
}

.app-loading-wrap {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: ${bg};
  z-index: 9;
  -webkit-app-region: drag;
  user-select: none;
  transition: opacity 0.35s ease;
}

.app-loading-wrap.fk-fade-out {
  opacity: 0;
  pointer-events: none;
}

.fk-logo-wrap {
  position: relative;
  width: 72px;
  height: 72px;
  animation: fk-fade-in 0.5s ease-out both,
             fk-glow-pulse 2.8s ease-in-out infinite;
  border-radius: 16px;
}

.fk-logo-svg {
  width: 72px;
  height: 72px;
  animation: fk-breathe 2.8s ease-in-out infinite;
}

.fk-shimmer-bar {
  margin-top: 28px;
  width: 96px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    ${shimmer} 20%,
    ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)'} 50%,
    ${shimmer} 80%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: fk-shimmer 1.8s ease-in-out infinite,
             fk-fade-in 0.6s ease-out 0.15s both;
}
  `

  const logoSVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" class="fk-logo-svg">
  <rect x="128" y="124" width="196" height="196" rx="36" fill="${rectBack}"/>
  <rect x="188" y="192" width="196" height="196" rx="36" fill="${rectFront}"/>
</svg>`

  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `
    <div class="fk-logo-wrap">${logoSVG}</div>
    <div class="fk-shimmer-bar"></div>
  `

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      oDiv.classList.add('fk-fade-out')
      setTimeout(() => {
        safeDOM.remove(document.head, oStyle)
        safeDOM.remove(document.body, oDiv)
      }, 350)
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