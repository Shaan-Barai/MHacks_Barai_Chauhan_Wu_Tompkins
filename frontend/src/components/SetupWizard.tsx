/**
 * First-time setup, shown once per browser: the dining hall names, then menus.
 * Meal times start from sensible defaults and can be changed in Settings.
 */
import { useState } from 'react'
import type { HallSettings } from '../data/types'
import { DEFAULT_SETTINGS } from '../state/settings'
import { LocationFields, cleanLocations } from './LocationFields'
import { MenuSource } from './MenuSource'
import { GhostButton, PrimaryButton } from './ui'

export function SetupWizard({ onComplete }: { onComplete: (settings: HallSettings) => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [draft, setDraft] = useState<HallSettings>(DEFAULT_SETTINGS)
  const named = cleanLocations(draft.locations).length > 0

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-10">
      <p className="font-display text-2xl font-semibold">ScrapSaver</p>
      <p className="mt-1 text-base">Step {step} of 2</p>

      {step === 1 && (
        <section className="mt-8" aria-label="Step 1: your dining hall">
          <h1 className="font-display text-3xl font-semibold">What is your dining hall called?</h1>
          <form
            className="mt-5 max-w-md"
            onSubmit={(e) => {
              e.preventDefault()
              if (named) setStep(2)
            }}
          >
            <LocationFields
              idPrefix="setup-hall-name"
              locations={draft.locations}
              onChange={(locations) => setDraft({ ...draft, locations })}
            />
            <p className="mt-4 text-sm">Meal times start at the usual hours. You can change them in Settings.</p>
            <PrimaryButton type="submit" className="mt-6" disabled={!named}>
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
            <MenuSource locations={cleanLocations(draft.locations)} />
          </div>
          <div className="mt-8 flex gap-3">
            <GhostButton type="button" onClick={() => setStep(1)}>
              Back
            </GhostButton>
            <PrimaryButton type="button" onClick={() => onComplete({ ...draft, locations: cleanLocations(draft.locations) })}>
              Go to the dashboard
            </PrimaryButton>
          </div>
        </section>
      )}
    </main>
  )
}
