/**
 * Which meal service a scan belongs to, from this computer's clock.
 *
 * The hall's local date and time (its IANA timezone) are matched against
 * meal windows (env MEAL_WINDOWS, e.g. "breakfast=05:00-10:59,lunch=11:00-15:59,
 * dinner=16:00-22:59"). Outside every window, or with no menu saved for
 * that meal, there is no service and the caller must pass --service.
 */

export type MealLabel = 'breakfast' | 'lunch' | 'dinner';

export interface MealWindow {
  meal: MealLabel;
  /** Inclusive, "HH:MM" local time. */
  start: string;
  end: string;
}

export interface ServiceLike {
  serviceId: string;
  hallId: string;
  hallTimezone: string;
  serviceDate: string;
  mealLabel: string;
}

export const DEFAULT_MEAL_WINDOWS = 'breakfast=05:00-10:59,lunch=11:00-15:59,dinner=16:00-22:59';

export function parseMealWindows(raw: string = DEFAULT_MEAL_WINDOWS): MealWindow[] {
  const windows: MealWindow[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(breakfast|lunch|dinner)=([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(part);
    if (!m) throw new Error(`MEAL_WINDOWS entry "${part}" must look like lunch=11:00-15:59.`);
    const start = `${m[2]}:${m[3]}`;
    const end = `${m[4]}:${m[5]}`;
    if (start > end) throw new Error(`MEAL_WINDOWS entry "${part}" ends before it starts.`);
    windows.push({ meal: m[1] as MealLabel, start, end });
  }
  return windows;
}

/** Local "YYYY-MM-DD" and "HH:MM" of `when` in `timeZone`. */
export function localDateTime(when: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(when)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export type ServiceResolution<S> =
  | { ok: true; service: S; meal: MealLabel; localDate: string }
  | { ok: false; reason: string };

export function resolveServiceAt<S extends ServiceLike>(
  services: S[],
  when: Date,
  options: { hallId: string; windows: MealWindow[]; timeZone?: string },
): ServiceResolution<S> {
  const hallServices = services.filter((s) => s.hallId === options.hallId);
  const timeZone = options.timeZone ?? hallServices[0]?.hallTimezone ?? 'America/Detroit';
  const { date, time } = localDateTime(when, timeZone);
  const window = options.windows.find((w) => w.start <= time && time <= w.end);
  if (!window) return { ok: false, reason: `No meal is being served at ${time} (${timeZone}); pass --service.` };
  const service = hallServices.find((s) => s.serviceDate === date && s.mealLabel === window.meal);
  if (!service) {
    return { ok: false, reason: `No ${window.meal} menu is saved for ${options.hallId} on ${date}; upload it or pass --service.` };
  }
  return { ok: true, service, meal: window.meal, localDate: date };
}
