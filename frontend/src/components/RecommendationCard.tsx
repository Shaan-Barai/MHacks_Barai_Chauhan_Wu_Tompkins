/**
 * AI recommendation (BIG-PLAN D8): Gemini text grounded in the shown numbers,
 * or a labeled rule-based fallback. Each bullet shows the number it rests on.
 * "Ask again" regenerates it on demand; when the AI is unavailable the last
 * saved recommendation is shown and labeled as such.
 */
import { useState } from 'react'
import type { Recommendation } from '../data/types'
import { plainText } from '../lib/text'
import { Badge, Card, GhostButton } from './ui'

export const SOURCE_LABEL: Record<Recommendation['source'], string> = {
  gemini: 'AI',
  fallback: 'Rule-based fallback',
}

export function RecommendationCard({ rec, onRegenerate }: { rec: Recommendation; onRegenerate?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function regenerate() {
    if (!onRegenerate) return
    setBusy(true)
    setError(null)
    try {
      await onRegenerate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ask the AI again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">Recommendations</h2>
        <div className="flex flex-wrap items-center gap-2">
          {rec.stale && <Badge>saved earlier</Badge>}
          <Badge>{SOURCE_LABEL[rec.source]}</Badge>
          {onRegenerate && (
            <GhostButton type="button" onClick={regenerate} disabled={busy}>
              Ask again
            </GhostButton>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <p className="mt-2 max-w-3xl text-base">{plainText(rec.text)}</p>
      {rec.bullets.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rec.bullets.map((b, i) => (
            <li key={i} className="border-l-4 border-ink pl-3">
              <p className="text-base">{plainText(b.text)}</p>
              <p className="text-sm opacity-60">{plainText(b.metric)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
