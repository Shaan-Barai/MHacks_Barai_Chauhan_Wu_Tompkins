/**
 * Forecast: how the prep forecast did against what happened, next to the
 * existing system's (FSS) forecast, plus what to prep for the coming week.
 * Numbers come from the forecast worker via /api/forecast/summary (formulas in
 * analytics/). A SIMULATED DATA banner shows whenever any number on the page
 * comes from simulated rows. Unknown values show a dash, never 0.
 */
import { useState } from 'react'
import { USE_MOCK, getForecastSummary } from '../data/api'
import type { ForecastComparison, ForecastSummary, UpcomingForecast } from '../data/types'
import { MEAL_NAME, type MealLabel } from '../data/types'
import { useAsync } from '../lib/useAsync'
import { formatNumber } from '../lib/format'
import { DateRangePicker, STATISTICS_PRESETS, defaultRange, type DateRange } from '../components/DateRangePicker'
import { Badge, Card, EmptyState, LoadingBlock } from '../components/ui'

const lb = (x: number | null) => (x === null ? '—' : `${x.toLocaleString(undefined, { maximumFractionDigits: 1 })} lb`)
const usd = (x: number | null) => (x === null ? '—' : x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)

function Tile({ title, value, detail }: { title: string; value: string; detail?: string }) {
  // "A vs. B" values are longer: one size down so they stay on one line.
  const size = value.includes(' vs. ') ? 'text-2xl sm:text-3xl' : 'text-2xl sm:text-4xl'
  return (
    <Card className="flex flex-col">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <p className={`mt-3 sm:whitespace-nowrap ${size} font-bold leading-none tracking-tight text-ink`} aria-label={`${title}: ${value}`}>{value}</p>
      {detail && <p className="mt-2 text-sm text-thyme">{detail}</p>}
    </Card>
  )
}

export function ForecastPage({ dataRevision = 0 }: { dataRevision?: number } = {}) {
  const [range, setRange] = useState<DateRange>(defaultRange)
  const summary = useAsync(() => getForecastSummary(range.start, range.end), [range.start, range.end, dataRevision])
  const data = summary.data
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-3 font-display text-3xl font-bold tracking-tight text-ink">Forecast{USE_MOCK && <Badge>Demo</Badge>}</h1>
        <DateRangePicker value={range} onChange={setRange} presets={STATISTICS_PRESETS} />
      </div>
      {data?.available && data.simulated && <SimulatedBanner />}
      {summary.status === 'loading' && !data && <LoadingBlock label="Loading forecasts" />}
      {summary.status === 'error' && <EmptyState title="Couldn't load forecasts.">{summary.error}</EmptyState>}
      {data && !data.available && (
        <EmptyState title="Forecasts are not set up on this server.">They need the Supabase database and the forecast worker.</EmptyState>
      )}
      {data?.available && <ForecastBody data={data} />}
    </div>
  )
}

function SimulatedBanner() {
  return (
    <p role="note" className="rounded-card border-4 border-ink p-3 text-base font-bold uppercase tracking-wide text-ink">
      Simulated data. These numbers come from made-up test data, not a real kitchen. Use them to see how the forecast works, not to plan.
    </p>
  )
}

function ForecastBody({ data }: { data: Extract<ForecastSummary, { available: true }> }) {
  const t = data.totals
  if (t.meals === 0 && data.upcoming.length === 0) {
    return <EmptyState title="No forecasts in this window yet.">Run the forecast worker, then confirm production sheets so it can be scored.</EmptyState>
  }
  return (
    <>
      <Totals t={t} label={data.comparisonLabel} />
      <DishTable data={data} />
      <Upcoming rows={data.upcoming} label={data.comparisonLabel} />
      <p className="text-sm text-thyme">
        {data.comparisonLabel !== 'FSS' && (
          <>
            “{data.comparisonLabel}” stands in for the dining hall’s FSS forecast until a real FSS export is loaded; it is not real FSS data.{' '}
          </>
        )}
        Error is the weighted absolute % difference between forecast and what was used, on meals that did not run out (when a dish runs out, true demand is
        unknown). A stockout is a meal where that amount would not have been enough. Dollar amounts are food cost plus each dish’s Waste Impact Score.
        Model {data.model}.
      </p>
    </>
  )
}

function Totals({ t, label }: { t: ForecastComparison; label: string }) {
  const traySource = t.trayWasteSources.includes('simulated') ? 'simulated' : t.trayWasteSources.length ? 'from calibrated scans (estimate)' : 'needs calibrated scans'
  return (
    <section aria-label="Forecast results for the selected days" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <Tile title={`Forecast error: ours vs. ${label}`} value={`${pct(t.ourWape)} vs. ${pct(t.fssWape)}`} detail={`over ${formatNumber(t.meals - t.ranOutMeals)} meals that did not run out`} />
      <Tile title={`Stockouts: ours vs. ${label}`} value={`${formatNumber(t.ourStockouts)} vs. ${t.fssStockouts === null ? '—' : formatNumber(t.fssStockouts)}`} detail={`${formatNumber(t.ranOutMeals)} of ${formatNumber(t.meals)} meals actually ran out`} />
      <Tile title="Pan leftover" value={lb(t.panLeftoverLb)} detail={`${usd(t.panLeftoverUsd)} · our forecast would have left ${lb(t.ourWouldLeaveLb)}`} />
      <Tile title="Tray waste" value={lb(t.trayWasteLb)} detail={`${usd(t.trayWasteUsd)} · ${traySource}`} />
    </section>
  )
}

function DishTable({ data }: { data: Extract<ForecastSummary, { available: true }> }) {
  if (data.dishes.length === 0) return null
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Forecast vs. actual by dish</h2>
      <p className="mt-1 text-sm text-thyme">Average pounds per meal. Biggest pan leftover first.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-base">
          <thead>
            <tr className="border-b-2 border-linen text-sm">
              <th className="py-2 pr-3">Dish</th>
              <th className="pr-3 text-right">Our prep</th>
              <th className="max-w-[9rem] pr-3 text-right">{data.comparisonLabel}</th>
              <th className="pr-3 text-right">Used</th>
              <th className="pr-3 text-right">Error ours / {data.comparisonLabel === 'FSS' ? 'FSS' : 'sim. FSS'}</th>
              <th className="pr-3 text-right">Ran out</th>
              <th className="pr-3 text-right">Pan leftover</th>
              <th className="text-right">Tray waste</th>
            </tr>
          </thead>
          <tbody>
            {data.dishes.map((d) => (
              <tr key={d.dishId} className="border-b border-linen/30">
                <td className="py-2 pr-3">
                  {d.displayName}
                  {d.simulated && <span className="ml-1 text-sm">(simulated)</span>}
                </td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{lb(d.avgRecommendedPrepLb)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{lb(d.avgFssLb)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{lb(d.avgConsumedLb)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{pct(d.ourWape)} / {pct(d.fssWape)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{formatNumber(d.ranOutMeals)} of {formatNumber(d.meals)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{lb(d.panLeftoverLb)}<span className="block text-sm">{usd(d.panLeftoverUsd)}</span></td>
                <td className="whitespace-nowrap text-right tabular-nums">{lb(d.trayWasteLb)}<span className="block text-sm">{usd(d.trayWasteUsd)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Upcoming({ rows, label }: { rows: UpcomingForecast[]; label: string }) {
  if (rows.length === 0) return null
  const mealOrder: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2 }
  const sorted = [...rows].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || (mealOrder[a.mealLabel] ?? 9) - (mealOrder[b.mealLabel] ?? 9))
  const groups = new Map<string, UpcomingForecast[]>()
  for (const r of sorted) groups.set(`${r.serviceDate}|${r.mealLabel}`, [...(groups.get(`${r.serviceDate}|${r.mealLabel}`) ?? []), r])
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">What to prep: next 7 days</h2>
      <p className="mt-1 text-sm text-thyme">Printable prep sheets per station: <code>python3 -m forecast.prep_sheet --date YYYY-MM-DD</code></p>
      <div className="mt-3 space-y-4">
        {[...groups.entries()].map(([key, list]) => {
          const [date, meal] = key.split('|') as [string, string]
          return (
            <section key={key} aria-label={`${date} ${meal}`}>
              <h3 className="font-semibold">
                {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}, {MEAL_NAME[meal as MealLabel] ?? meal}
                {list[0]?.expectedDiners ? <span className="font-normal"> · about {formatNumber(list[0].expectedDiners)} diners</span> : null}
              </h3>
              <ul className="mt-1 divide-y divide-linen/30">
                {list.map((r) => (
                  <li key={r.dishId} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                    <span className="min-w-[14rem] font-medium">{r.displayName}{r.simulated && <span className="ml-1 text-sm font-normal">(simulated)</span>}</span>
                    <span className="tabular-nums font-bold">{lb(r.recommendedPrepLb)}</span>
                    <span className="tabular-nums text-sm">range {lb(r.lowLb)}–{lb(r.highLb)}</span>
                    {r.fssForecastLb !== null && <span className="tabular-nums text-sm">{label}: {lb(r.fssForecastLb)}</span>}
                    {r.why && <span className="basis-full text-sm text-thyme">{r.why}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Card>
  )
}
