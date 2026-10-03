/** Browser-local preview settings. Dated events replace the recurring day schedule. */
export interface MealTime { id: string; name: string; start: string; end: string }
export interface DaySchedule { id: string; name: string; days: number[]; meals: MealTime[] }
export interface EventSchedule { id: string; name: string; date: string; meals: MealTime[] }
export interface HallSettings { hallName: string; schedules: DaySchedule[]; events: EventSchedule[] }
