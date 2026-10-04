import { useCallback, useEffect, useState } from 'react'
import { AdminPage } from './pages/AdminPage'
import { BehindScenesPage, TRY_PATH } from './pages/BehindScenesPage'
import { DashboardPage } from './pages/DashboardPage'
import { LandingPage } from './pages/LandingPage'
import { MenusPage } from './pages/MenusPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PortionsPage } from './pages/PortionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatisticsPage } from './pages/StatisticsPage'
import { AuthProvider } from './state/auth'
import { DEFAULT_SETTINGS, useHallSettings } from './state/settings'

type Page = 'landing' | 'dashboard' | 'statistics' | 'menus' | 'portions' | 'behind' | 'settings' | 'admin'

const NAV: { page: Page; label: string; path: string }[] = [
  { page: 'dashboard', label: 'Dashboard', path: '/dashboard' },
  { page: 'statistics', label: 'Statistics', path: '/statistics' },
  { page: 'menus', label: 'Menus', path: '/menus' },
  { page: 'portions', label: 'Portions served', path: '/portions' },
  { page: 'behind', label: 'Behind the scenes', path: '/behind-the-scenes' },
  { page: 'settings', label: 'Settings', path: '/settings' },
]

/** Unlisted: the owner opens /admin directly to choose which plates are counted. */
const HIDDEN: { page: Page; label: string; path: string }[] = [{ page: 'admin', label: 'Admin', path: '/admin' }]

/** Path -> page; null = no such page (404). The server sends index.html for every non-API path. */
export function pageForPath(pathname: string): Page | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/index.html') return 'landing'
  if (path === '/schedule') return 'statistics'
  if (path === TRY_PATH) return 'behind'
  return [...NAV, ...HIDDEN].find((n) => n.path === path)?.page ?? null
}

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next: string) => {
    if (next !== window.location.pathname) window.history.pushState(null, '', next)
    setPath(next)
  }, [])
  return [path, go]
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}

function Shell() {
  const { settings, update } = useHallSettings()
  const [path, go] = usePath()
  const page = pageForPath(path)
  const [dataRevision, setDataRevision] = useState(0)

  const title = page === 'landing' ? null : page ? [...NAV, ...HIDDEN].find((n) => n.page === page)!.label : 'Page not found'
  useEffect(() => {
    document.title = title ? `${title} · ScrapSaver` : 'ScrapSaver'
  }, [title])

  if (page === 'landing') return <LandingPage onStart={() => go('/dashboard')} />
  const hall = settings ?? DEFAULT_SETTINGS

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:p-2 focus:text-ink">
        Skip to content
      </a>
      {/* Left: narrow nav, black with white text */}
      <nav className="flex w-full shrink-0 flex-col bg-ink p-4 text-cream lg:w-56" aria-label="Main">
        <a
          href="/"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            go('/')
          }}
          className="font-display text-2xl font-bold tracking-tight"
        >
          ScrapSaver
        </a>
        <ul className="mt-3 flex flex-wrap gap-1 lg:mt-6 lg:block lg:space-y-1">
          {NAV.map((item) => (
            <li key={item.page}>
              <a
                href={item.path}
                aria-current={page === item.page ? 'page' : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                  e.preventDefault()
                  go(item.path)
                }}
                className={`block w-full rounded-btn px-3 py-2 text-left text-base ${
                  page === item.page ? 'bg-cream font-semibold text-ink' : 'text-cream hover:underline'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main id="main" className="min-w-0 flex-1 overflow-y-auto bg-cream p-4 sm:p-6">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'statistics' && <StatisticsPage dataRevision={dataRevision} />}
        {page === 'menus' && <MenusPage />}
        {page === 'portions' && <PortionsPage onSaved={() => setDataRevision((r) => r + 1)} />}
        {page === 'behind' && <BehindScenesPage path={path} onNavigate={go} />}
        {page === 'settings' && <SettingsPage settings={hall} onSave={update} />}
        {page === 'admin' && <AdminPage />}
        {page === null && <NotFoundPage onHome={() => go('/dashboard')} />}
      </main>
    </div>
  )
}
