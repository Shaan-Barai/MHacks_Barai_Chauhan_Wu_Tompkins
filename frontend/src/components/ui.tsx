import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useId } from 'react'
import type { ApiError } from '../data/types'

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-soft)] ${className}`}>
      {children}
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }

export function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  const styles = {
    primary: 'bg-primary text-surface hover:bg-primary/90',
    secondary: 'border border-border bg-surface text-ink hover:bg-primary-soft',
    ghost: 'text-primary hover:bg-primary-soft',
  }[variant]
  return (
    <button
      type="button"
      className={`rounded-[var(--radius-btn)] px-4 py-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...rest}
    />
  )
}

/** Segmented control used for meal tabs and chart grouping. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-[var(--radius-btn)] border border-border bg-bg p-1">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`rounded-md font-medium transition-colors ${size === 'sm' ? 'px-3 py-1 text-sm' : 'px-4 py-1.5'} ${
              active ? 'bg-primary text-surface' : 'text-ink-muted hover:bg-primary-soft hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Small "?" that reveals a plain-language explanation on hover or focus. */
export function InfoTip({ children }: { children: ReactNode }) {
  const id = useId()
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-describedby={id}
        aria-label="What does this mean?"
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs text-ink-muted hover:bg-primary-soft"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-[var(--radius-btn)] bg-ink px-3 py-2 text-sm font-normal normal-case leading-snug tracking-normal text-surface opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {children}
      </span>
    </span>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-[var(--radius-btn)] bg-border/60 ${className}`} />
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border px-6 py-10 text-center">
      <p className="font-display text-xl text-ink">{title}</p>
      {children && <p className="max-w-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-high/40 bg-high/5 px-6 py-8 text-center">
      <p className="font-display text-xl text-ink">Couldn't load this</p>
      <p className="max-w-sm text-ink-muted">{error.message}</p>
      {error.retryable && onRetry && (
        <Button variant="secondary" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  )
}

/** Small pill marking AI estimates / simulated values. */
export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'info' | 'warn' }) {
  const styles = {
    muted: 'bg-bg text-ink-muted border-border',
    info: 'bg-info/10 text-info border-info/20',
    warn: 'bg-medium/15 text-ink border-medium/40',
  }[tone]
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>
}
