/**
 * Forecast page: the walk-forward model comparison (forecast/backtest.py, GET /api/forecast/models).
 * Every row is scored on the same meals. A SIMULATED banner shows whenever the run was built from
 * simulated rows; unknown values show "—", never 0.
 */
import type { ModelComparison as ModelComparisonData, ModelComparisonRow } from '../data/types'
import { formatNumber } from '../lib/format'
import { Card } from './ui'

const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`)
const usd = (x: number | null) => (x === null ? '—' : x.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))
const MODE: Record<ModelComparisonRow['mode'], string> = { default: 'Default service levels', matched_stockouts: 'Matched stockouts', as_given: 'As given' }
const NAME: Record<string, string> = {
  'baseline-v1': 'Baseline (cycle day)',
  'seasonal-naive-v1': 'Seasonal naive',
  'moving-avg-4-v1': 'Moving average (4)',
  'exp-smoothing-v1': 'Exponential smoothing',
  'gbm-v1': 'Gradient boosting',
}

export function ModelComparison({ data }: { data: Extract<ModelComparisonData, { available: true }> }) {
  const first = data.rows[0]
  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Model comparison{data.simulated && ' (simulated)'}</h2>
      {data.simulated && (
        <p role="note" className="mt-2 rounded-card border-4 border-ink p-3 text-base font-bold uppercase tracking-wide text-ink">
          Simulated data. This comparison was run on made-up test data, not a real kitchen. It shows how the models are compared, not which one works best for M-Dining.
        </p>
      )}
      <p className="mt-2 text-sm text-thyme">
        Walk-forward backtest, {data.window.start} to {data.window.end}: each forecast used only data from before its day.{' '}
        {first && `${formatNumber(first.meals)} dish-meals, the same for every row (${formatNumber(first.censoredMeals)} ran out and are left out of error and bias).`}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-base">
          <thead>
            <tr className="border-b-2 border-linen text-sm">
              <th className="py-2 pr-3">Model</th>
              <th className="pr-3">Mode</th>
              <th className="pr-3 text-right">Error (WAPE)</th>
              <th className="pr-3 text-right">Bias</th>
              <th className="pr-3 text-right">Stockouts</th>
              <th className="pr-3 text-right">Pan leftover</th>
              <th className="pr-3 text-right">10–90% range held actual</th>
              <th className="text-right">Avg service level</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.modelVersion}/${r.mode}`} className="border-b border-linen/30">
                <td className="py-2 pr-3">
                  {r.modelVersion === 'fss' ? data.comparisonLabel ?? 'FSS' : NAME[r.modelVersion] ?? r.modelVersion}
                  <span className="block text-sm text-thyme">{r.modelVersion}</span>
                </td>
                <td className="pr-3 text-sm">{MODE[r.mode]}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{pct(r.wape)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{pct(r.bias)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{formatNumber(r.stockouts)}</td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">
                  {r.leftoverLb === null ? '—' : `${formatNumber(Math.round(r.leftoverLb))} lb`}
                  <span className="block text-sm">{usd(r.leftoverUsd)}</span>
                </td>
                <td className="whitespace-nowrap pr-3 text-right tabular-nums">{pct(r.intervalCoverage, 0)}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{r.meanQ === null ? '—' : r.meanQ.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm text-thyme">
        Matched stockouts: each model's service levels are moved together until it runs out no more often than the comparison forecast, so leftovers are compared at the
        same risk of running out. The 10–90% range should hold the actual about 80% of the time.
      </p>
    </Card>
  )
}
