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
 * Preload loading screen.
 * Uses a synthetic percent value while the renderer boots, then converges to
 * 100% when React posts the ready message.
 */
function useLoading() {
  const styleContent = `
/* ---------- Preload Loading Screen ---------- */

@keyframes fk-loader-enter {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.app-loading-wrap {
  --fk-reveal-size: 0px;
  --fk-progress-ratio: 0%;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #000;
  color: #fff;
  z-index: 2147483647;
  -webkit-app-region: drag;
  user-select: none;
  isolation: isolate;
  animation: fk-loader-enter 0.28s ease-out both;
  transition: background-color 0.24s ease;
}

.app-loading-wrap.fk-exiting {
  background-color: transparent;
  pointer-events: none;
}

.fk-reveal-circle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--fk-reveal-size);
  height: var(--fk-reveal-size);
  border-radius: 50%;
  background: #fff;
  transform: translate(-50%, -50%);
  opacity: 1;
  filter: blur(0);
  will-change: width, height, transform, opacity, filter;
  transition:
    opacity 0.76s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.76s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.76s cubic-bezier(0.22, 1, 0.36, 1);
}

.app-loading-wrap.fk-exiting .fk-reveal-circle {
  opacity: 0;
  filter: blur(18px);
  transform: translate(-50%, -50%) scale(1.08);
}

.fk-progress-stack {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
  mix-blend-mode: difference;
  text-align: center;
  opacity: 1;
  transform: translateX(-0.02em);
  transition:
    opacity 0.34s ease,
    transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.app-loading-wrap.fk-exiting .fk-progress-stack {
  opacity: 0;
  transform: translateX(-0.02em) translateY(-10px) scale(0.96);
}

.fk-percent {
  font-family:
    ui-sans-serif,
    -apple-system,
    BlinkMacSystemFont,
    'SF Pro Display',
    'Segoe UI',
    sans-serif;
  font-size: clamp(76px, 15vw, 168px);
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.085em;
  line-height: 0.84;
}

.fk-wordmark {
  margin-top: clamp(18px, 2.8vh, 26px);
  font-family:
    ui-monospace,
    'SFMono-Regular',
    'SF Mono',
    Menlo,
    Consolas,
    monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.34em;
  line-height: 1;
  opacity: 0.78;
  text-transform: uppercase;
}

.fk-progress-track {
  position: relative;
  width: clamp(118px, 20vw, 188px);
  height: 1px;
  margin-top: 18px;
  overflow: hidden;
  background: rgb(255 255 255 / 0.22);
}

.fk-progress-track::before {
  content: '';
  position: absolute;
  inset: 0;
  width: var(--fk-progress-ratio);
  background: currentColor;
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
  .app-loading-wrap {
    animation: none;
    transition-duration: 0.18s;
  }

  .fk-reveal-circle,
  .fk-progress-stack {
    transition-duration: 0.18s;
  }

  .app-loading-wrap.fk-exiting .fk-reveal-circle {
    filter: none;
    transform: translate(-50%, -50%);
  }
}
  `

  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let animationFrameId: number | undefined
  let hasMounted = false
  let hasCompleted = false
  let readyRequested = false
  let startedAt = 0
  let progress = 0
  let maxRevealSize = 0

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.setAttribute('role', 'progressbar')
  oDiv.setAttribute('aria-label', 'FusionKit loading')
  oDiv.setAttribute('aria-live', 'polite')
  oDiv.setAttribute('aria-valuemin', '0')
  oDiv.setAttribute('aria-valuemax', '100')
  oDiv.innerHTML = `
    <div class="fk-reveal-circle" aria-hidden="true"></div>
    <div class="fk-progress-stack" aria-hidden="true">
      <div class="fk-percent">00%</div>
      <div class="fk-wordmark">FusionKit</div>
      <div class="fk-progress-track"></div>
    </div>
    <span class="fk-sr-only">FusionKit is starting</span>
  `

  const progressLabel = oDiv.querySelector<HTMLElement>('.fk-percent')

  const formatPercent = (value: number) => {
    const rounded = Math.min(100, Math.max(0, Math.round(value)))
    return `${rounded < 10 ? `0${rounded}` : rounded}%`
  }

  const renderProgress = (value: number) => {
    progress = Math.min(100, Math.max(0, value))
    const rounded = Math.min(100, Math.max(0, Math.round(progress)))
    const revealSize = maxRevealSize * (progress / 100)

    oDiv.style.setProperty('--fk-reveal-size', `${revealSize}px`)
    oDiv.style.setProperty('--fk-progress-ratio', `${progress}%`)
    oDiv.setAttribute('aria-valuenow', String(rounded))
    oDiv.setAttribute('aria-valuetext', `${rounded}%`)

    if (progressLabel) {
      progressLabel.textContent = formatPercent(progress)
    }
  }

  const updateViewportMetrics = () => {
    const width = window.innerWidth || document.documentElement.clientWidth || 1
    const height = window.innerHeight || document.documentElement.clientHeight || 1
    const radiusToFarthestCorner = Math.sqrt(width * width + height * height) / 2

    maxRevealSize = Math.ceil(radiusToFarthestCorner * 2)
    renderProgress(progress)
  }

  const cleanupLoading = () => {
    if (animationFrameId !== undefined) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = undefined
    }

    window.removeEventListener('resize', updateViewportMetrics)
    safeDOM.remove(document.head, oStyle)
    safeDOM.remove(document.body, oDiv)
  }

  const completeLoading = () => {
    if (hasCompleted) return

    hasCompleted = true
    renderProgress(100)

    requestAnimationFrame(() => {
      oDiv.classList.add('fk-exiting')
    })

    setTimeout(cleanupLoading, prefersReducedMotion ? 220 : 820)
  }

  const tick = (time: number) => {
    if (!hasMounted || hasCompleted) return
    if (!startedAt) startedAt = time

    if (prefersReducedMotion && !readyRequested) {
      animationFrameId = requestAnimationFrame(tick)
      return
    }

    const elapsed = time - startedAt
    const syntheticTarget = Math.min(92, 92 * (1 - Math.exp(-elapsed / 1800)))
    const target = readyRequested ? 100 : syntheticTarget
    const easing = readyRequested ? 0.24 : 0.055
    const nextProgress = progress + (target - progress) * easing

    renderProgress(nextProgress)

    if (readyRequested && nextProgress >= 99.75) {
      completeLoading()
      return
    }

    animationFrameId = requestAnimationFrame(tick)
  }

  const startProgress = () => {
    if (animationFrameId !== undefined || hasCompleted) return
    animationFrameId = requestAnimationFrame(tick)
  }

  return {
    appendLoading() {
      if (hasCompleted) return

      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
      hasMounted = true
      updateViewportMetrics()
      window.addEventListener('resize', updateViewportMetrics)
      startProgress()
    },
    removeLoading() {
      if (hasCompleted) return

      readyRequested = true

      if (!hasMounted) {
        hasCompleted = true
        return
      }

      startProgress()
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
