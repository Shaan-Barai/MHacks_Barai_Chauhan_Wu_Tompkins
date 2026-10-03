import type { DemoService } from '../contracts/demo.js';
import type { HallSettings, MealTime } from '../contracts/schedule.js';

export const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const mealNames = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function datesInRange(end: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => shiftDate(end, index - days + 1));
}

export function dateLabel(date: string, short = false): string {
  return new Intl.DateTimeFormat('en-US', { month: short ? 'short' : 'long', day: 'numeric', ...(short ? {} : { year: 'numeric' as const }), timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function foodName(name: string | undefined, id: string): string {
  const value = (name?.trim() && !/^item[_-]/i.test(name)) ? name.trim() : (name || id).split('+').at(-1)!;
  if (/^item[_-]/i.test(value) || !value.trim()) return 'Unnamed food';
  const readable = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export function displayServices(services: readonly DemoService[]): DemoService[] {
  return services.map(service => ({ ...service, items: service.items.map(item => ({ ...item, name: foodName(item.name, item.id) })) }));
}

const baseMeals = (): MealTime[] => [
  { id: 'breakfast', name: 'Breakfast', start: '07:00', end: '10:00' },
  { id: 'lunch', name: 'Lunch', start: '11:00', end: '14:00' },
  { id: 'dinner', name: 'Dinner', start: '17:00', end: '20:00' },
];

export function defaultSettings(hallName: string): HallSettings {
  return { hallName, schedules: [
    { id: 'weekdays', name: 'Weekdays', days: [1, 2, 3, 4, 5], meals: baseMeals() },
    { id: 'weekends', name: 'Weekends', days: [0, 6], meals: baseMeals().map(meal => meal.id === 'breakfast' ? { ...meal, start: '08:00', end: '11:00' } : meal) },
  ], events: [] };
}

export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`))
    && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
}

export function validateSettings(settings: HallSettings): string | null {
  if (!settings.hallName.trim()) return 'Enter a dining hall name.';
  const occupied = new Set<number>();
  const dates = new Set<string>();
  for (const schedule of settings.schedules) {
    if (!schedule.name.trim() || !schedule.days.length) return 'Name each regular schedule and choose its days.';
    for (const day of schedule.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) return 'Choose a valid day.';
      if (occupied.has(day)) return `${dayNames[day]} has two regular schedules. Keep it in one.`;
      occupied.add(day);
    }
  }
  for (const event of settings.events) {
    if (!event.name.trim() || !validDate(event.date)) return 'Give each event a name and a valid date.';
    if (dates.has(event.date)) return 'Use one event schedule per date. Add extra meals inside that event.';
    dates.add(event.date);
  }
  for (const schedule of [...settings.schedules, ...settings.events]) {
    if (!schedule.meals.length) return `Add a meal to ${schedule.name}.`;
    for (const meal of schedule.meals) {
      if (!meal.name.trim()) return 'Name every meal.';
      if (![meal.start, meal.end].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return 'Enter valid meal times.';
      if (meal.start >= meal.end) return `${meal.name} must finish after it starts. Split overnight meals into two time slots.`;
    }
  }
  return null;
}

export function loadSettings(storage: Pick<Storage, 'getItem'>, hallName: string): HallSettings {
  try {
    const saved = JSON.parse(storage.getItem('scrap-saver-settings-v1') || 'null');
    if (saved && !validateSettings(saved)) return saved;
  } catch { /* Missing or damaged browser settings use the defaults. */ }
  return defaultSettings(hallName);
}

export function scheduleForDate(settings: HallSettings, date: string) {
  const event = settings.events.find(candidate => candidate.date === date);
  if (event) return { name: event.name, meals: event.meals, isEvent: true };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const regular = settings.schedules.find(candidate => candidate.days.includes(day));
  return regular ? { name: regular.name, meals: regular.meals, isEvent: false } : null;
}

export function timeLabel(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
}
