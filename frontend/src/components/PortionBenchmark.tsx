import type { PortionBenchmark as Benchmark } from '../data/types'
import { formatNumber } from '../lib/format'

/** Waste per portion: Pixels wasted per portion served, once counted scans and portion counts exist. */
export function PortionBenchmarkView({ benchmark }: { benchmark: Benchmark }) {
  const ranked = benchmark.items.filter((i) => i.pixelsWastedPerPortion !== null)
  return (
    <section aria-label="Waste per portion" className="space-y-3">
      <h2 className="text-lg font-semibold text-ink">Waste per portion</h2>
      {ranked.length === 0 ? (
        <p className="text-base">Not available yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Foods ranked by waste per portion</caption>
            <thead>
              <tr className="border-b border-ink">
                <th scope="col" className="py-2 pr-3">Food</th>
                <th scope="col" className="py-2 pr-3">Portions served</th>
                <th scope="col" className="py-2">Waste per portion</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((i) => (
                <tr key={i.itemId} className="border-b border-ink">
                  <th scope="row" className="py-2 pr-3 font-semibold">{i.displayName}</th>
                  <td className="pr-3">
                    {formatNumber(i.portionsServed ?? 0)}
                    {i.portionsSource === 'demo' && ' (demo)'}
                  </td>
                  <td>{formatNumber(Math.round(i.pixelsWastedPerPortion ?? 0))} pixels per portion</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-sm">
            Based on {benchmark.measuredDishes} of {benchmark.capturedDishes} scanned plates.
          </p>
        </div>
      )}
    </section>
  )
}
