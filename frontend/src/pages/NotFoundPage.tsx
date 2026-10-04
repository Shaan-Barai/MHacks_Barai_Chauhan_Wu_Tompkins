/** Any path the dashboard doesn't know (the server answers every non-API path with the app). */
import { useEffect, useRef } from 'react'
import { PrimaryButton } from '../components/ui'

export function NotFoundPage({ onHome }: { onHome: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <div className="max-w-xl space-y-4">
      <h1 ref={heading} tabIndex={-1} className="font-display text-3xl font-semibold text-ink">
        We couldn't find that page.
      </h1>
      <p className="text-base">The link may be old or mistyped. Everything is on the dashboard and the pages on the left.</p>
      <PrimaryButton type="button" onClick={onHome}>
        Go to the dashboard
      </PrimaryButton>
    </div>
  )
}
