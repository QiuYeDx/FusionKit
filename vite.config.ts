import { rmSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isVitest = process.env.VITEST === 'true'
  if (!isVitest) rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG
  const appVersion = process.env.VITE_APP_VERSION ?? pkg.version
  const electronVersion = pkg.devDependencies.electron
  const reactVersion = pkg.devDependencies.react
  const dependencyNames = Object.keys('dependencies' in pkg ? pkg.dependencies : {})
  const srcAlias = path.join(__dirname, 'src')

  return {
    resolve: {
      alias: {
        '@': srcAlias
      },
    },
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_ELECTRON_VERSION': JSON.stringify(electronVersion),
      'import.meta.env.VITE_REACT_VERSION': JSON.stringify(reactVersion),
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(isVitest ? [] : [electron({
        main: {
          // Shortcut of `build.lib.entry`
          entry: 'electron/main/index.ts',
          onstart(args) {
            if (process.env.VSCODE_DEBUG) {
              console.log(/* For `.vscode/.debug.script.mjs` */'[startup] Electron App')
            } else {
              args.startup()
            }
          },
          vite: {
            resolve: {
              alias: {
                '@': srcAlias,
              },
            },
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: dependencyNames,
              },
            },
          },
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: 'electron/preload/index.ts',
          vite: {
            resolve: {
              alias: {
                '@': srcAlias,
              },
            },
            build: {
              sourcemap: sourcemap ? 'inline' : undefined, // #332
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rollupOptions: {
                // Sandboxed preloads cannot require arbitrary npm packages.
                // Bundle every imported runtime dependency and leave Electron external.
                external: ['electron'],
              },
            },
          },
        },
        // Ployfill the Electron and Node.js API for Renderer process.
        // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
        // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer: {},
      })]),
    ],
    server: process.env.VSCODE_DEBUG && (() => {
      const url = new URL(pkg.debug.env.VITE_DEV_SERVER_URL)
      return {
        host: url.hostname,
        port: +url.port,
      }
    })(),
    clearScreen: false,
  }
})
