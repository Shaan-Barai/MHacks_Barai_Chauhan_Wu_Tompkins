/**
 * Per-day line chart: estimated carbon emissions (kg CO2e) by day, a black line
 * with a dot per day, hover (and keyboard-focus) tooltip with the exact value and
 * date. Days with no data break the line (a gap, never a drop to zero). Hand-rolled SVG.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { formatKgCo2e } from '../lib/format'
import { niceCeil, type ChartBucket } from '../lib/grouping'

const valueText = (v: number) => formatKgCo2e(v)
const axisText = (v: number) => (v === 0 ? '0' : v >= 0.1 ? `${+v.toFixed(2)} kg` : `${Math.round(v * 1000)} g`)

const LINE = '#000000'
const GRID = '#000000'
const LABEL = '#000000'

const M = { top: 12, right: 8, bottom: 30, left: 52 }
const HEIGHT = 300

export function WasteChart({ buckets }: { buckets: ChartBucket[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const n = buckets.length
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = HEIGHT - M.top - M.bottom
  const max = niceCeil(Math.max(0, ...buckets.map((b) => b.value ?? 0)))
  const band = plotW / Math.max(1, n)
  const xFor = (i: number) => M.left + i * band + band / 2
  const yFor = (v: number) => M.top + plotH - (v / max) * plotH

  // Runs of consecutive days with data; a missing day ends the run.
  const runs: Array<Array<{ x: number; y: number }>> = []
  let run: Array<{ x: number; y: number }> = []
  buckets.forEach((b, i) => {
    if (b.value === null) {
      if (run.length) runs.push(run)
      run = []
    } else run.push({ x: xFor(i), y: yFor(b.value) })
  })
  if (run.length) runs.push(run)
  const dotR = band >= 10 ? 3 : 0 // dots only when days are far enough apart to read

  // ~6 evenly spaced x labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(n / 6))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  const hovered = hover !== null ? buckets[hover] : null
  const hoverCenter = hover !== null ? xFor(hover) : 0
  const tooltipLeft = Math.min(Math.max(hoverCenter, 70), width - 70)

  return (
    <div ref={containerRef} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label="Line chart of estimated carbon emissions per day"
      >
        {/* recessive hairline gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={yFor(t)} y2={yFor(t)} stroke={GRID} strokeWidth={1} strokeDasharray="2 4" />
            <text x={M.left - 8} y={yFor(t) + 4} textAnchor="end" fontSize={12} fill={LABEL}>
              {axisText(t)}
            </text>
          </g>
        ))}

        {/* hover guide */}
        {hovered && hovered.value !== null ? (
          <line x1={hoverCenter} x2={hoverCenter} y1={M.top} y2={M.top + plotH} stroke={GRID} strokeWidth={1} />
        ) : null}

        {/* Black line, broken at days with no data */}
        {runs.map((r) =>
          r.length > 1 ? (
            <polyline
              key={`${r[0]!.x}`}
              points={r.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={LINE}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null,
        )}

        {/* A dot per day (always for a lone day, so it isn't invisible); larger on hover */}
        {buckets.map((b, i) => {
          if (b.value === null) return null
          const lone = (i === 0 || buckets[i - 1]!.value === null) && (i === n - 1 || buckets[i + 1]!.value === null)
          const r = hover === i ? 5 : lone ? Math.max(dotR, 3) : dotR
          return r > 0 ? <circle key={b.key} cx={xFor(i)} cy={yFor(b.value)} r={r} fill={LINE} /> : null
        })}

        {/* baseline */}
        <line x1={M.left} x2={width - M.right} y1={M.top + plotH} y2={M.top + plotH} stroke={GRID} strokeWidth={1} />

        {/* x labels */}
        {buckets.map((b, i) =>
          i % labelEvery === 0 ? (
            <text
              key={b.key}
              x={xFor(i)}
              y={HEIGHT - 10}
              textAnchor="middle"
              fontSize={12}
              fill={LABEL}
            >
              {b.label}
            </text>
          ) : null,
        )}

        {/* full-height hit targets: hover + keyboard focus both open the tooltip */}
        {buckets.map((b, i) => (
          <rect
            key={b.key}
            x={M.left + i * band}
            y={M.top}
            width={Math.max(band, 6)}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={
              b.value === null ? `${b.tooltipLabel}: no data` : `${b.tooltipLabel}: ${valueText(b.value)}`
            }
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {hovered ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-btn bg-ink px-3 py-1.5 text-sm text-cream shadow-soft"
          style={{ left: tooltipLeft }}
        >
          <span className="font-semibold">
            {hovered.value === null ? 'No data' : valueText(hovered.value)}
          </span>
          <span className="ml-2">{hovered.tooltipLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
