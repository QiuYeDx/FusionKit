import { defineConfig } from 'vitest/config'
import path from 'path'

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
