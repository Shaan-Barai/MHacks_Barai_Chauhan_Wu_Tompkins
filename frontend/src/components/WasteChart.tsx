/**
 * The one main chart (UI.md): waste score, estimated grams, or Pixels wasted
 * per day as a black line with a dot per day (dots hidden past 45 days), and a
 * hover (and keyboard-focus) tooltip with the exact value and date. Days with
 * no data break the line. Hand-rolled SVG.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { formatCompact, formatGrams, formatNumber } from '../lib/format'
import { niceCeil, type ChartBucket, type ChartUnit } from '../lib/grouping'

function tickLabel(v: number, unit: ChartUnit): string {
  if (unit === 'pixels' || unit === 'score') return formatCompact(v)
  if (v === 0) return '0'
  // 6.3 kg / 12.5 kg: one decimal at most so quarter ticks stay distinct.
  return v >= 1000 ? `${Number((v / 1000).toFixed(1))} kg` : `${Number(v.toFixed(1))} g`
}

function valueText(v: number, unit: ChartUnit): string {
  if (unit === 'score') return `Waste score ${formatNumber(v)}`
  return unit === 'grams' ? `${formatGrams(v)} left (estimate)` : `${formatNumber(v)} pixels wasted`
}

const CHART_SUBJECT: Record<ChartUnit, string> = { grams: 'estimated food left', pixels: 'pixels wasted', score: 'waste score' }

const LINE = '#000000'
const GRID = '#000000'
const LABEL = '#000000'

const M = { top: 12, right: 8, bottom: 30, left: 52 }
const HEIGHT = 300

export function WasteChart({ buckets, unit = 'pixels' }: { buckets: ChartBucket[]; unit?: ChartUnit }) {
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
  const yFor = (v: number) => M.top + plotH - (v / max) * plotH
  const xFor = (i: number) => M.left + i * band + band / 2

  // A day with no data on either side has no line, so its dot always shows.
  const isolated = (i: number) => (buckets[i - 1]?.value ?? null) === null && (buckets[i + 1]?.value ?? null) === null

  // Runs of consecutive days with data, each drawn as one line.
  const segments: number[][] = []
  buckets.forEach((b, i) => {
    if (b.value === null) return
    const last = segments[segments.length - 1]
    if (last && last[last.length - 1] === i - 1) last.push(i)
    else segments.push([i])
  })

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
        aria-label={`Line chart of ${CHART_SUBJECT[unit]} per day for the selected days`}
      >
        {/* recessive hairline gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={yFor(t)} y2={yFor(t)} stroke={GRID} strokeWidth={1} strokeDasharray="2 4" />
            <text x={M.left - 8} y={yFor(t) + 4} textAnchor="end" fontSize={12} fill={LABEL}>
              {tickLabel(t, unit)}
            </text>
          </g>
        ))}

        {/* guide under the hovered day */}
        {hovered && hovered.value !== null && (
          <line x1={xFor(hover!)} x2={xFor(hover!)} y1={M.top} y2={M.top + plotH} stroke={GRID} strokeWidth={1} />
        )}

        {/* Black line through the days with data; a day with no data breaks the line */}
        {segments.map((seg) => (
          <polyline
            key={seg[0]}
            points={seg.map((i) => `${xFor(i)},${yFor(buckets[i].value!)}`).join(' ')}
            fill="none"
            stroke={LINE}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {buckets.map((b, i) =>
          b.value === null ? null : (
            <circle key={b.key} cx={xFor(i)} cy={yFor(b.value)} r={hover === i ? 5 : n > 45 && !isolated(i) ? 0 : 3} fill={LINE} />
          ),
        )}

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
              b.value === null ? `${b.tooltipLabel}: no data` : `${b.tooltipLabel}: ${valueText(b.value, unit)}`
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
            {hovered.value === null ? 'No data' : valueText(hovered.value, unit)}
          </span>
          <span className="ml-2">{hovered.tooltipLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
