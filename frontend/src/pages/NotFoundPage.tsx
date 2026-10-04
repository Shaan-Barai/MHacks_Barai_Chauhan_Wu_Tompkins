/** Any path the dashboard doesn't know (the server answers every non-API path with the app). */
import { useEffect, useRef } from 'react'
import { PrimaryButton } from '../components/ui'

export function NotFoundPage({ onHome }: { onHome: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <div className="max-w-xl space-y-4">
      <h1 ref={heading} tabIndex={-1} className="font-display text-3xl font-bold tracking-tight text-ink">
        Page not found
      </h1>
      <PrimaryButton type="button" onClick={onHome}>
        Dashboard
      </PrimaryButton>
    </div>
  )
}
