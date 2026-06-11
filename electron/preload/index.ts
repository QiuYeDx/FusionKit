import { ipcRenderer, contextBridge, webUtils } from 'electron'
import { animate, motionValue } from 'motion'

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
  --fk-exit-radius: 0px;
  --fk-exit-edge: 1px;
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
  will-change: width, height, opacity;
}

.fk-exit-mask {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  -webkit-mask-image: radial-gradient(
    circle at center,
    transparent 0 var(--fk-exit-radius),
    #000 var(--fk-exit-edge)
  );
  mask-image: radial-gradient(
    circle at center,
    transparent 0 var(--fk-exit-radius),
    #000 var(--fk-exit-edge)
  );
  will-change: opacity, -webkit-mask-image, mask-image;
}

.fk-exit-mask.fk-exit-mask-solid {
  -webkit-mask-image: none;
  mask-image: none;
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
  will-change: opacity, transform;
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
  .app-loading-wrap { animation: none; }
}
  `

  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const minimumCountDuration = prefersReducedMotion ? 180 : 1200
  const minimumCompleteHold = prefersReducedMotion ? 80 : 180
  const exitRevealDuration = prefersReducedMotion ? 220 : 920
  const completeSweepDuration = prefersReducedMotion ? 120 : 420
  const exitTextDuration = prefersReducedMotion ? 120 : 500
  const layerSwapDuration = prefersReducedMotion ? 80 : 180
  const syntheticProgressCeiling = 92

  const springTransition = (durationMs: number) => ({
    type: 'spring' as const,
    duration: durationMs / 1000,
    bounce: 0,
  })

  let hasMounted = false
  let hasCompleted = false
  let readyRequested = false
  let minimumCountCompleted = false
  let isCompleting = false
  let progress = 0
  let maxRevealSize = 0
  let maxExitRadius = 0
  let progressAnimation: ReturnType<typeof animate> | undefined
  let completeAnimation: ReturnType<typeof animate> | undefined
  let exitRevealAnimation: ReturnType<typeof animate> | undefined
  let exitTextAnimation: ReturnType<typeof animate> | undefined
  let layerSwapAnimation: ReturnType<typeof animate> | undefined
  let exitMaskAnimation: ReturnType<typeof animate> | undefined
  let minimumCountTimer: ReturnType<typeof setTimeout> | undefined
  let completeSweepTimer: ReturnType<typeof setTimeout> | undefined
  let completeHoldTimer: ReturnType<typeof setTimeout> | undefined
  let exitRevealStartTimer: ReturnType<typeof setTimeout> | undefined
  let exitRevealCleanupTimer: ReturnType<typeof setTimeout> | undefined

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
    <div class="fk-exit-mask" aria-hidden="true"></div>
    <div class="fk-progress-stack" aria-hidden="true">
      <div class="fk-percent">00%</div>
      <div class="fk-wordmark">FusionKit</div>
      <div class="fk-progress-track"></div>
    </div>
    <span class="fk-sr-only">FusionKit is starting</span>
  `

  const progressLabel = oDiv.querySelector<HTMLElement>('.fk-percent')
  const progressStack = oDiv.querySelector<HTMLElement>('.fk-progress-stack')
  const revealCircle = oDiv.querySelector<HTMLElement>('.fk-reveal-circle')
  const exitMask = oDiv.querySelector<HTMLElement>('.fk-exit-mask')

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
    maxExitRadius = Math.ceil(radiusToFarthestCorner + 32)
    renderProgress(progress)
  }

  const renderExitReveal = (ratio: number) => {
    const clampedRatio = Math.min(1, Math.max(0, ratio))
    const radius = maxExitRadius * clampedRatio

    oDiv.style.setProperty('--fk-exit-radius', `${radius}px`)
    oDiv.style.setProperty('--fk-exit-edge', `${radius + 1}px`)
  }

  const progressMotion = motionValue(0)
  const exitRevealMotion = motionValue(0)
  const unsubscribeProgress = progressMotion.on('change', renderProgress)
  const unsubscribeExitReveal = exitRevealMotion.on('change', renderExitReveal)

  const cleanupLoading = () => {
    progressAnimation?.stop()
    completeAnimation?.stop()
    exitRevealAnimation?.stop()
    exitTextAnimation?.stop()
    layerSwapAnimation?.stop()
    exitMaskAnimation?.stop()
    progressAnimation = undefined
    completeAnimation = undefined
    exitRevealAnimation = undefined
    exitTextAnimation = undefined
    layerSwapAnimation = undefined
    exitMaskAnimation = undefined

    ;[
      minimumCountTimer,
      completeSweepTimer,
      completeHoldTimer,
      exitRevealStartTimer,
      exitRevealCleanupTimer,
    ].forEach((timer) => {
      if (timer !== undefined) clearTimeout(timer)
    })
    minimumCountTimer = undefined
    completeSweepTimer = undefined
    completeHoldTimer = undefined
    exitRevealStartTimer = undefined
    exitRevealCleanupTimer = undefined
    unsubscribeProgress()
    unsubscribeExitReveal()

    window.removeEventListener('resize', updateViewportMetrics)
    safeDOM.remove(document.head, oStyle)
    safeDOM.remove(document.body, oDiv)
  }

  const playExitReveal = () => {
    oDiv.classList.add('fk-exiting')

    if (progressStack) {
      exitTextAnimation = animate(
        progressStack,
        {
          opacity: 0,
          transform: 'translateX(-0.02em) translateY(-10px) scale(0.96)',
        },
        springTransition(exitTextDuration),
      )
    }

    if (revealCircle) {
      layerSwapAnimation = animate(
        revealCircle,
        { opacity: 0 },
        springTransition(layerSwapDuration),
      )
    }

    exitRevealStartTimer = setTimeout(() => {
      exitMask?.classList.remove('fk-exit-mask-solid')
      exitRevealMotion.set(0)
      exitRevealAnimation = animate(exitRevealMotion, 1, {
        ...springTransition(exitRevealDuration),
        onComplete: cleanupLoading,
      })
      exitRevealCleanupTimer = setTimeout(cleanupLoading, exitRevealDuration + 160)
      exitRevealStartTimer = undefined
    }, exitTextDuration)
  }

  const enterCompleteHold = () => {
    if (hasCompleted) return

    hasCompleted = true
    progressMotion.set(100)
    exitRevealMotion.set(0)
    if (exitMask) {
      exitMask.classList.add('fk-exit-mask-solid')
      exitMask.style.opacity = '1'
    }

    progressAnimation?.stop()
    completeAnimation?.stop()
    progressAnimation = undefined
    completeAnimation = undefined
    if (completeSweepTimer !== undefined) {
      clearTimeout(completeSweepTimer)
      completeSweepTimer = undefined
    }

    completeHoldTimer = setTimeout(() => {
      playExitReveal()
      completeHoldTimer = undefined
    }, minimumCompleteHold)
  }

  const playCompleteSweep = () => {
    if (isCompleting || hasCompleted) return
    isCompleting = true
    progressAnimation?.stop()
    progressAnimation = undefined

    completeAnimation = animate(progressMotion, 100, {
      ...springTransition(completeSweepDuration),
      onComplete: enterCompleteHold,
    })
    completeSweepTimer = setTimeout(enterCompleteHold, completeSweepDuration + 80)
  }

  const completeMinimumCount = () => {
    if (minimumCountCompleted || hasCompleted) return

    minimumCountCompleted = true
    progressAnimation?.stop()
    progressAnimation = undefined
    if (minimumCountTimer !== undefined) {
      clearTimeout(minimumCountTimer)
      minimumCountTimer = undefined
    }
    progressMotion.set(syntheticProgressCeiling)

    if (readyRequested) {
      playCompleteSweep()
    }
  }

  const startProgress = () => {
    if (progressAnimation !== undefined || hasCompleted) return

    progressAnimation = animate(progressMotion, syntheticProgressCeiling, {
      ...springTransition(minimumCountDuration),
      onComplete: completeMinimumCount,
    })
    minimumCountTimer = setTimeout(completeMinimumCount, minimumCountDuration + 80)
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

      if (minimumCountCompleted) {
        playCompleteSweep()
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
