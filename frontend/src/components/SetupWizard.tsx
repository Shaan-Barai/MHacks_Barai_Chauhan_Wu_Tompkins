/**
 * First-time setup (UI.md): three steps, shown once (persisted to localStorage).
 *   1. Hall name + editable default meal hours.
 *   2. Menus — "Connect a menu API" or "Upload menus myself".
 *   3. "You're all set" → Dashboard.
 */
import { useState } from 'react'
import type { HallSettings } from '../data/types'
import { DEFAULT_SETTINGS } from '../state/settings'
import { MealTimesFields } from './MealTimesFields'
import { MenuSource } from './MenuSource'
import { FieldLabel, GhostButton, PrimaryButton, inputClass } from './ui'

export function SetupWizard({ onComplete }: { onComplete: (settings: HallSettings) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [draft, setDraft] = useState<HallSettings>(DEFAULT_SETTINGS)

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-10">
      <p className="font-display text-2xl font-semibold text-basil">Scrap</p>
      <p className="mt-1 text-base text-thyme">Plate waste, made simple.</p>

      <ol aria-label="Setup progress" className="mt-6 flex gap-2">
        {[1, 2, 3].map((s) => (
          <li
            key={s}
            aria-current={step === s ? 'step' : undefined}
            className={`h-2 w-16 rounded-full ${s <= step ? 'bg-basil' : 'bg-linen'}`}
          >
            <span className="sr-only">Step {s}{step === s ? ' (current)' : ''}</span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <section className="mt-8" aria-label="Step 1: your dining hall">
          <h1 className="font-display text-3xl font-semibold text-ink">Tell us about your dining hall</h1>
          <div className="mt-5 max-w-md">
            <FieldLabel htmlFor="setup-hall-name">Dining hall name</FieldLabel>
            <input
              id="setup-hall-name"
              placeholder="e.g. South Quad Dining"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={inputClass}
            />
          </div>
          <h2 className="mt-6 text-lg font-semibold text-ink">Meal times</h2>
          <p className="mb-3 mt-1 text-base text-thyme">These defaults usually work — adjust them if your hours differ.</p>
          <MealTimesFields value={draft.mealTimes} onChange={(mealTimes) => setDraft({ ...draft, mealTimes })} />
          <div className="mt-8">
            <PrimaryButton type="button" onClick={() => setStep(2)} disabled={!draft.name.trim()}>
              Next: add menus
            </PrimaryButton>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="mt-8" aria-label="Step 2: add menus">
          <h1 className="font-display text-3xl font-semibold text-ink">How do you want to add menus?</h1>
          <p className="mt-1 text-base text-thyme">
            Scrap matches plate waste to your menu items. You can always add more days later in Menus.
          </p>
          <div className="mt-5">
            <MenuSource />
          </div>
          <div className="mt-8 flex gap-3">
            <GhostButton type="button" onClick={() => setStep(1)}>
              Back
            </GhostButton>
            <PrimaryButton type="button" onClick={() => setStep(3)}>
              Continue
            </PrimaryButton>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="mt-8" aria-label="Step 3: all set">
          <h1 className="font-display text-3xl font-semibold text-ink">You're all set! 🎉</h1>
          <p className="mt-2 max-w-lg text-base text-thyme">
            {draft.name.trim()} is ready. The dashboard shows waste units — the AI-estimated leftover food area seen on
            plates — plus the items driving it and simple tips to cut it down.
          </p>
          <div className="mt-8 flex gap-3">
            <GhostButton type="button" onClick={() => setStep(2)}>
              Back
            </GhostButton>
            <PrimaryButton type="button" onClick={() => onComplete(draft)}>
              Go to Dashboard
            </PrimaryButton>
          </div>
        </section>
      )}
    </main>
  )
}
