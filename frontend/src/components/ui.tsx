import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-linen bg-cream p-5 shadow-soft ${className}`}>{children}</div>
}

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props
  return (
    <button
      {...rest}
      className={`rounded-btn bg-basil px-5 py-2.5 text-base font-semibold text-cream transition-colors hover:underline disabled:cursor-not-allowed disabled:border disabled:border-dashed disabled:border-ink disabled:bg-cream disabled:text-ink disabled:no-underline ${className}`}
    />
  )
}

export function GhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props
  return (
    <button
      {...rest}
      className={`rounded-btn border border-linen bg-cream px-5 py-2.5 text-base font-medium text-ink transition-colors hover:underline disabled:cursor-not-allowed disabled:border-dashed disabled:no-underline ${className}`}
    />
  )
}

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-base font-medium text-thyme">
      {children}
    </label>
  )
}

export const inputClass =
  'w-full rounded-btn border border-linen bg-cream px-3 py-2 text-base text-ink placeholder:italic placeholder:text-ink'

/**
 * Accessible "?" tooltip: shows on hover and keyboard focus; the text is also
 * available to screen readers via aria-describedby.
 */
export function InfoTip({ id, text }: { id: string; text: string }) {
  return (
    <span className="group relative inline-block align-middle">
      <button
        type="button"
        aria-describedby={id}
        aria-label="What does this mean?"
        className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-linen bg-cream text-xs font-semibold text-ink"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden w-60 -translate-x-1/2 rounded-btn bg-ink px-3 py-2 text-sm leading-snug text-cream shadow-soft group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  )
}

export const PIXELS_WASTED_EXPLANATION =
  'Pixels wasted counts the leftover food in each plate photo, pixel by pixel, inside outlines the AI draws around the food. The counting is exact; the outlines are an AI estimate. It is not weight, servings, or the share of food first served.'

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-linen bg-cream p-8 text-center">
      <p className="text-lg font-medium text-ink">{title}</p>
      {children ? <p className="mt-2 text-base text-thyme">{children}</p> : null}
    </div>
  )
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-card border border-linen bg-cream p-8 text-center text-base text-thyme">
      {label}
    </div>
  )
}

/** Small pill reminding that a value is simulated or AI-generated. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-linen bg-oat px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-thyme">
      {children}
    </span>
  )
}
