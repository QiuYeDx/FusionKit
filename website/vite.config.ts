import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 4321 },
  // three.js (the hero particles) is one ~520 kB chunk, loaded lazily after first paint.
  build: { chunkSizeWarningLimit: 600 },
})
