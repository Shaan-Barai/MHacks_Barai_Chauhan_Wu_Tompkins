import { useState } from 'react'
import { defaultRange, type DateRange } from './components/DateRangePicker'
import { SetupWizard } from './components/SetupWizard'
import { BehindScenesPage } from './pages/BehindScenesPage'
import { DashboardPage } from './pages/DashboardPage'
import { MenuSchedulePage } from './pages/MenuSchedulePage'
import { PortionsPage } from './pages/PortionsPage'
import { SettingsPage } from './pages/SettingsPage'
import { useHallSettings } from './state/settings'

type Page = 'dashboard' | 'menu-schedule' | 'portions' | 'behind' | 'settings'

const NAV: { page: Page; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'menu-schedule', label: 'Menu Schedule' },
  { page: 'portions', label: 'Portions served' },
  { page: 'behind', label: 'Behind the scenes' },
  { page: 'settings', label: 'Settings' },
]

export default function App() {
  const { settings, update } = useHallSettings()
  const [page, setPage] = useState<Page>('dashboard')
  const [range, setRange] = useState<DateRange>(defaultRange)
  const [dataRevision, setDataRevision] = useState(0)
  /** Dashboard scope: one hallId, or 'all' for every location together. */
  const [dashboardHall, setDashboardHall] = useState<string>('all')

  if (!settings) {
    return <SetupWizard onComplete={update} />
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Left: narrow nav, black with white text */}
      <nav className="flex w-full shrink-0 flex-col bg-ink p-4 text-cream lg:w-48" aria-label="Main">
        <p className="font-display text-2xl font-semibold">ScrapSaver</p>
        <p className="mt-0.5 truncate text-sm" title={settings.halls.map((h) => h.name).join(', ')}>
          {settings.halls.length > 1 ? `${settings.halls.length} dining halls` : settings.name}
        </p>
        <ul className="mt-3 flex flex-wrap gap-1 lg:mt-6 lg:block lg:space-y-1">
          {NAV.map((item) => (
            <li key={item.page}>
              <button
                type="button"
                aria-current={page === item.page ? 'page' : undefined}
                onClick={() => setPage(item.page)}
                className={`w-full rounded-btn px-3 py-2 text-left text-base ${
                  page === item.page ? 'bg-cream font-semibold text-ink' : 'text-cream hover:underline'
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-auto hidden pt-6 text-xs leading-snug lg:block">
          Pixels wasted come from AI outlines of plate photos. Impact points are relative. Meal swipes are simulated for the demo.
        </p>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto bg-cream p-4 sm:p-6">
        {page === 'dashboard' && (
          <DashboardPage
            range={range}
            onRangeChange={setRange}
            halls={settings.halls}
            hall={settings.halls.some((h) => h.hallId === dashboardHall) ? dashboardHall : 'all'}
            onHallChange={setDashboardHall}
          />
        )}
        {page === 'menu-schedule' && <MenuSchedulePage settings={settings} dataRevision={dataRevision} />}
        {page === 'portions' && <PortionsPage onSaved={() => setDataRevision((r) => r + 1)} />}
        {page === 'behind' && <BehindScenesPage />}
        {page === 'settings' && <SettingsPage settings={settings} onSave={update} />}
      </main>
    </div>
  )
}
