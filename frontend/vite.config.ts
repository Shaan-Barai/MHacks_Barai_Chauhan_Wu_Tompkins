/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Node 22+ ships a built-in localStorage global (undefined without
// --localstorage-file) that shadows jsdom's; turn it off for test workers.
const nodeMajor = Number(process.versions.node.split('.')[0])
const execArgv = nodeMajor >= 22 ? ['--no-experimental-webstorage'] : []

/** KEY=value pairs from the repo-root .env (missing file = none). Values are never logged. */
function rootEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(resolve(__dirname, '../.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The ONLY Supabase values the browser bundle may contain: the project API URL
 * and the anon/publishable key (RLS limits it to reading dashboard tables).
 * Read through this allow-list, never an env prefix, so SUPABASE_SERVICE_ROLE_KEY
 * cannot reach the bundle. A key that looks secret is refused.
 */
function publicSupabase(): { url: string; anonKey: string } {
  const env = rootEnv()
  const url = process.env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? ''
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY ?? ''
  if (/^sb_secret_/.test(anonKey) || (anonKey !== '' && anonKey === (process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY))) {
    throw new Error('Refusing to build: the Supabase key meant for the browser is a secret (service role) key.')
  }
  // Without a project API URL (https://<ref>.supabase.co) live refresh stays off.
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) || anonKey === '') return { url: '', anonKey: '' }
  return { url, anonKey }
}

export default defineConfig(({ mode }) => {
  const supabase = mode === 'test' ? { url: '', anonKey: '' } : publicSupabase()
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabase.url),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabase.anonKey),
    },
    // Dev: the dashboard calls the backend through /api (backend/README.md).
    // Pin to IPv4 loopback: Vite's default can bind [::1] only, so 127.0.0.1 checks failed (D11).
    server: { host: '127.0.0.1', proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787' } },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      globals: false,
      poolOptions: { forks: { execArgv }, threads: { execArgv } },
    },
  }
})
