import type { PortionBenchmark as Benchmark } from '../data/types'
import { formatNumber } from '../lib/format'

export function PortionBenchmarkView({ benchmark }: { benchmark: Benchmark }) {
  return <section aria-label="Pixels wasted per portion" className="space-y-3">
    <h2 className="text-lg font-semibold text-ink">Pixels wasted per portion</h2>
    <p className="text-sm text-thyme">Visible leftover-food pixels from validated AI masks ÷ portions served for the same meal. Higher values indicate more observed waste per portion.</p>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Food item benchmarks, ranked by pixels wasted per portion</caption>
        <thead><tr className="border-b border-linen text-thyme">
          <th scope="col" className="py-2 pr-3">Food</th><th scope="col" className="py-2 pr-3">Portions served</th>
          <th scope="col" className="py-2 pr-3">Pixels wasted</th><th scope="col" className="py-2">Pixels/portion</th>
        </tr></thead>
        <tbody>{benchmark.items.map(i => <tr key={i.itemId} className="border-b border-linen">
          <th scope="row" className="py-3 pr-3 font-medium text-ink">{i.displayName}
            {i.unavailableReason && <p className="mt-1 text-xs font-normal text-thyme">{i.unavailableReason}</p>}</th>
          <td className="pr-3">{i.portionsServed === null ? 'Missing' : formatNumber(i.portionsServed)}{i.portionsSource === 'demo' && ' (demo)'}</td>
          <td className="pr-3">{i.pixelsWasted === null ? 'Unavailable' : formatNumber(i.pixelsWasted)}</td>
          <td>{i.pixelsWastedPerPortion === null ? 'Unavailable' : formatNumber(Math.round(i.pixelsWastedPerPortion * 100) / 100)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs text-thyme">{benchmark.coverageNote} {benchmark.excludedMeasurements > 0 && `${benchmark.excludedMeasurements} measurement(s) excluded from these benchmarks.`} AI mask boundaries can be uncertain.</p>
  </section>
}
