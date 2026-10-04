/**
 * One name box per dining hall, with "Add another location". Used by setup
 * and Settings. Empty boxes are dropped when saving (see cleanLocations).
 */
import { useEffect, useRef } from 'react'
import type { HallLocation } from '../data/types'
import { newId } from '../state/settings'
import { FieldLabel, GhostButton, inputClass } from './ui'

export function cleanLocations(locations: HallLocation[]): HallLocation[] {
  return locations.map((l) => ({ ...l, name: l.name.trim() })).filter((l) => l.name)
}

export function LocationFields({
  idPrefix,
  locations,
  onChange,
}: {
  idPrefix: string
  locations: HallLocation[]
  onChange: (next: HallLocation[]) => void
}) {
  // Focus a box only when the manager adds it, not on first render.
  const focusIndex = useRef<number | null>(null)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  useEffect(() => {
    if (focusIndex.current !== null) {
      inputs.current[focusIndex.current]?.focus()
      focusIndex.current = null
    }
  }, [locations.length])

  const several = locations.length > 1

  return (
    <div className="space-y-4">
      {locations.map((location, i) => (
        <div key={location.id}>
          <FieldLabel htmlFor={`${idPrefix}-${i}`}>{several ? `Dining hall ${i + 1}` : 'Dining hall name'}</FieldLabel>
          <div className="flex gap-2">
            <input
              id={`${idPrefix}-${i}`}
              ref={(el) => {
                inputs.current[i] = el
              }}
              placeholder={i === 0 ? 'e.g. South Quad Dining' : 'e.g. Bursley Dining'}
              value={location.name}
              onChange={(e) => onChange(locations.map((l, j) => (j === i ? { ...l, name: e.target.value } : l)))}
              className={inputClass}
            />
            {several && (
              <GhostButton
                type="button"
                aria-label={`Remove dining hall ${i + 1}`}
                onClick={() => onChange(locations.filter((_, j) => j !== i))}
              >
                Remove
              </GhostButton>
            )}
          </div>
        </div>
      ))}
      <GhostButton
        type="button"
        onClick={() => {
          focusIndex.current = locations.length
          onChange([...locations, { id: newId('hall'), name: '' }])
        }}
      >
        Add another location
      </GhostButton>
    </div>
  )
}
