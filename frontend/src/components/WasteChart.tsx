/**
 * The one main chart (UI.md): waste units per day (1 unit = 1,000 Pixels
 * wasted) as a black line with a dot on each day that has data. Days without
 * data break the line instead of dropping to zero. Hover (and keyboard focus)
 * shows the exact value and date. Hand-rolled SVG.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { formatCompact, formatWasteUnits, toWasteUnits } from '../lib/format'
import { niceCeil, type ChartBucket } from '../lib/grouping'

/** Buckets carry Pixels wasted; the chart shows them in waste units. */
const valueText = (pixels: number) => `${formatWasteUnits(pixels)} waste units`

const LINE = '#000000'
const GRID = '#000000'
const LABEL = '#000000'

const M = { top: 12, right: 12, bottom: 30, left: 52 }
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
  const units = buckets.map((b) => (b.value === null ? null : toWasteUnits(b.value)))
  const max = niceCeil(Math.max(0, ...units.map((u) => u ?? 0)))
  const band = plotW / Math.max(1, n)
  const xFor = (i: number) => M.left + i * band + band / 2
  const yFor = (u: number) => M.top + plotH - (u / max) * plotH

  // One path, lifting the pen over days without data.
  let d = ''
  let penDown = false
  units.forEach((u, i) => {
    if (u === null) {
      penDown = false
      return
    }
    d += `${penDown ? 'L' : 'M'} ${xFor(i)} ${yFor(u)} `
    penDown = true
  })

  // ~6 evenly spaced x labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(n / 6))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  const hovered = hover !== null ? buckets[hover] : null
  const tooltipLeft = hover !== null ? Math.min(Math.max(xFor(hover), 80), width - 80) : 0

  return (
    <div ref={containerRef} className="relative">
      <svg width={width} height={HEIGHT} role="img" aria-label="Line graph of waste units per day for the selected days">
        {/* recessive hairline gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={yFor(t)} y2={yFor(t)} stroke={GRID} strokeWidth={1} strokeDasharray="2 4" />
            <text x={M.left - 8} y={yFor(t) + 4} textAnchor="end" fontSize={12} fill={LABEL}>
              {formatCompact(t)}
            </text>
          </g>
        ))}

        {/* baseline */}
        <line x1={M.left} x2={width - M.right} y1={M.top + plotH} y2={M.top + plotH} stroke={GRID} strokeWidth={1} />

        <path d={d} fill="none" stroke={LINE} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {units.map((u, i) =>
          u === null ? null : (
            <circle key={buckets[i].key} cx={xFor(i)} cy={yFor(u)} r={hover === i ? 5 : 3} fill={LINE} />
          ),
        )}
        {hover !== null && units[hover] !== null && (
          <line x1={xFor(hover)} x2={xFor(hover)} y1={M.top} y2={M.top + plotH} stroke={GRID} strokeWidth={1} strokeDasharray="2 4" />
        )}

        {/* x labels */}
        {buckets.map((b, i) =>
          i % labelEvery === 0 ? (
            <text key={b.key} x={xFor(i)} y={HEIGHT - 10} textAnchor="middle" fontSize={12} fill={LABEL}>
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
            aria-label={b.value === null ? `${b.tooltipLabel}: no data` : `${b.tooltipLabel}: ${valueText(b.value)}`}
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
          <span className="font-semibold">{hovered.value === null ? 'No data' : valueText(hovered.value)}</span>
          <span className="ml-2">{hovered.tooltipLabel}</span>
        </div>
      ) : null}
    </div>
  )
}
