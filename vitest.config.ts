import { defineConfig } from 'vitest/config'
import path from 'path'

// Electron UI tests inherit this through `...process.env`. "quiet" keeps their
// windows off-screen and unfocused; see electron/main/test-window-mode.ts.
process.env.FUSIONKIT_TEST_WINDOW ||= 'quiet'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    root: __dirname,
    include: [
      'test/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    testTimeout: 1000 * 29,
  },
})
