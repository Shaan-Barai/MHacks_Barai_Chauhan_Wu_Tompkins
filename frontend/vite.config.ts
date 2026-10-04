/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Node 22+ ships a built-in localStorage global (undefined without
// --localstorage-file) that shadows jsdom's; turn it off for test workers.
const nodeMajor = Number(process.versions.node.split('.')[0])
const execArgv = nodeMajor >= 22 ? ['--no-experimental-webstorage'] : []

export default defineConfig({
  plugins: [react()],
  // Dev: the dashboard calls the backend through /api (backend/README.md).
  // Pin to IPv4 loopback: Vite's default can bind [::1] only, so 127.0.0.1 checks failed (D11).
  server: { host: '127.0.0.1', proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
    poolOptions: { forks: { execArgv }, threads: { execArgv } },
  },
})
