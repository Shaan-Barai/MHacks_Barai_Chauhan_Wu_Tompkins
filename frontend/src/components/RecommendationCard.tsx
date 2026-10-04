/**
 * AI recommendation (BIG-PLAN D8): Gemini text grounded in the shown numbers,
 * or a labeled rule-based fallback. Each bullet shows the number it rests on.
 */
import type { Recommendation } from '../data/types'
import { plainText } from '../lib/text'
import { Badge, Card } from './ui'

export const SOURCE_LABEL: Record<Recommendation['source'], string> = {
  gemini: 'AI',
  fallback: 'Rule-based fallback',
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'at an unknown time'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function RecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-ink">What to try next</h2>
        <Badge>{SOURCE_LABEL[rec.source]}</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-base">{plainText(rec.text)}</p>
      {rec.bullets.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rec.bullets.map((b, i) => (
            <li key={i} className="border-l-4 border-ink pl-3">
              <p className="text-base">{plainText(b.text)}</p>
              <p className="text-sm">
                <span className="font-semibold">Based on:</span> {plainText(b.metric)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm">
        {rec.source === 'gemini' ? 'Written by AI' : 'Basic rule, AI unavailable'} on {formatWhen(rec.generatedAt)}. Suggestions show
        where to look, not why food was left.
      </p>
    </Card>
  )
}
