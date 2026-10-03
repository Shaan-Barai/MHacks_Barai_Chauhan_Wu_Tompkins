import { useState } from 'react'
import { defaultRange, isSingleDay, type DateRange } from './components/DateRangePicker'
import { RightPanel } from './components/RightPanel'
import { SetupWizard } from './components/SetupWizard'
import { DashboardPage } from './pages/DashboardPage'
import { MenusPage } from './pages/MenusPage'
import { SettingsPage } from './pages/SettingsPage'
import { PortionsPage } from './pages/PortionsPage'
import { addDays, todayIso } from './lib/dates'
import { useHallSettings } from './state/settings'

type Page = 'dashboard' | 'menus' | 'portions' | 'settings'

const NAV: { page: Page; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'menus', label: 'Menus' },
  { page: 'portions', label: 'Portions served' },
  { page: 'settings', label: 'Settings' },
]

export default function App() {
  const { settings, update } = useHallSettings()
  const [page, setPage] = useState<Page>('dashboard')
  const [range, setRange] = useState<DateRange>(defaultRange)
  const [dataRevision, setDataRevision] = useState(0)

  if (!settings) {
    return <SetupWizard onComplete={update} />
  }

  // Right panel shows yesterday — or the picked date when the range is one day.
  const single = isSingleDay(range)
  const detailDate = single ? range.start : addDays(todayIso(), -1)

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Left: narrow nav, Basil with cream text */}
      <nav className="flex w-full shrink-0 flex-col bg-basil p-4 text-cream lg:w-44" aria-label="Main">
        <p className="font-display text-2xl font-semibold">Scrap</p>
        <p className="mt-0.5 truncate text-sm text-cream/80" title={settings.name}>
          {settings.name}
        </p>
        <ul className="mt-3 flex flex-wrap gap-1 lg:mt-6 lg:block lg:space-y-1">
          {NAV.map((item) => (
            <li key={item.page}>
              <button
                type="button"
                aria-current={page === item.page ? 'page' : undefined}
                onClick={() => setPage(item.page)}
                className={`w-full rounded-btn px-3 py-2 text-left text-base transition-colors ${
                  page === item.page ? 'bg-cream font-semibold text-basil' : 'text-cream hover:bg-cream/15'
                }`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-auto hidden pt-6 text-xs leading-snug text-cream/70 lg:block">
          Waste figures are AI estimates; attendance is simulated for the demo.
        </p>
      </nav>

      {/* Middle: Oat background */}
      <main className="min-w-0 flex-1 overflow-y-auto bg-oat p-4 sm:p-6">
        {page === 'dashboard' && <DashboardPage range={range} onRangeChange={setRange} />}
        {page === 'menus' && <MenusPage />}
        {page === 'portions' && <PortionsPage onSaved={() => setDataRevision(r => r + 1)} />}
        {page === 'settings' && <SettingsPage settings={settings} onSave={update} />}
      </main>

      {/* Right: Cream with Linen left border */}
      {page !== 'portions' && <RightPanel dataRevision={dataRevision} date={detailDate} isYesterday={!single} />}
    </div>
  )
}
