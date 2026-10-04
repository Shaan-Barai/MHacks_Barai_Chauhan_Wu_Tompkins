/**
 * First-time setup, shown once per browser: the dining hall names (one or
 * more locations), then menus. Meal times start from sensible defaults and
 * can be changed in Settings.
 */
import { useState } from 'react'
import type { HallSettings } from '../data/types'
import { DEFAULT_SETTINGS, assignHallIds, withHalls } from '../state/settings'
import { MenuSource } from './MenuSource'
import { FieldLabel, GhostButton, PrimaryButton, inputClass } from './ui'

export function SetupWizard({ onComplete }: { onComplete: (settings: HallSettings) => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [names, setNames] = useState<string[]>([''])
  const filled = names.map((n) => n.trim()).filter(Boolean)
  const draft: HallSettings = withHalls(DEFAULT_SETTINGS, assignHallIds(filled.map((name) => ({ name }))))
  const setName = (i: number, value: string) => setNames((all) => all.map((n, j) => (j === i ? value : n)))

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-10">
      <p className="font-display text-2xl font-semibold">ScrapSaver</p>
      <p className="mt-1 text-base">Step {step} of 2</p>

      {step === 1 && (
        <section className="mt-8" aria-label="Step 1: your dining hall">
          <h1 className="font-display text-3xl font-semibold">What are your dining halls called?</h1>
          <form
            className="mt-5 max-w-md"
            onSubmit={(e) => {
              e.preventDefault()
              if (filled.length > 0) setStep(2)
            }}
          >
            <ul className="space-y-4">
              {names.map((name, i) => (
                <li key={i}>
                  <FieldLabel htmlFor={`setup-hall-name-${i}`}>{i === 0 ? 'Dining hall name' : `Location ${i + 1}`}</FieldLabel>
                  <div className="flex gap-2">
                    <input
                      id={`setup-hall-name-${i}`}
                      placeholder={i === 0 ? 'e.g. South Quad Dining' : 'e.g. Bursley Dining'}
                      value={name}
                      onChange={(e) => setName(i, e.target.value)}
                      className={inputClass}
                      autoFocus={i > 0 && i === names.length - 1}
                    />
                    {i > 0 && (
                      <GhostButton
                        type="button"
                        aria-label={`Remove location ${i + 1}`}
                        onClick={() => setNames((all) => all.filter((_, j) => j !== i))}
                      >
                        Remove
                      </GhostButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setNames((all) => [...all, ''])}
              className="mt-3 rounded-btn px-2 py-1 text-base font-semibold underline"
            >
              + Add another location
            </button>
            <p className="mt-2 text-sm">Meal times start at the usual hours. You can change them, and add or rename locations, in Settings.</p>
            <PrimaryButton type="submit" className="mt-6" disabled={filled.length === 0}>
              Next
            </PrimaryButton>
          </form>
        </section>
      )}

      {step === 2 && (
        <section className="mt-8" aria-label="Step 2: add menus">
          <h1 className="font-display text-3xl font-semibold">Add this week's menus</h1>
          <p className="mt-1 text-base">We match leftovers to the foods on your menu. You can skip this and add menus later.</p>
          <div className="mt-5">
            <MenuSource halls={draft.halls} />
          </div>
          <div className="mt-8 flex gap-3">
            <GhostButton type="button" onClick={() => setStep(1)}>
              Back
            </GhostButton>
            <PrimaryButton type="button" onClick={() => onComplete(draft)}>
              Go to the dashboard
            </PrimaryButton>
          </div>
        </section>
      )}
    </main>
  )
}
