import type { DemoMeasurement, DemoService } from '../contracts/demo.js';

export interface FoodTotal {
  id: string;
  name: string;
  remainingAreaPx: number;
  baselineAreaPx: number;
  assessedServings: number;
  wastePercent: number | null;
  sharePercent: number;
}

export interface Summary {
  remainingAreaPx: number;
  baselineAreaPx: number;
  wastePercent: number | null;
  attendance: number | null;
  remainingAreaPxPerSimulatedAttendee: number | null;
  capturedDishes: number;
  successfulAnalyses: number;
  failedAnalyses: number;
  reviewAnalyses: number;
  excludedMeasurements: number;
  assessedServings: number;
  averagePlateWastePercent: number | null;
  averagedPlates: number;
  cleanPlates: number;
  excludedPlates: number;
  foods: FoodTotal[];
}

function eligible(measurement: DemoMeasurement, service: DemoService): boolean {
  const item = service.items.find(candidate => candidate.id === measurement.itemId);
  return !!item && measurement.baselineId === item.baselineId
    && measurement.baselineAreaPx === item.baselineAreaPx
    && Number.isFinite(measurement.remainingAreaPx) && measurement.remainingAreaPx >= 0
    && measurement.baselineAreaPx !== null && Number.isFinite(measurement.baselineAreaPx) && measurement.baselineAreaPx > 0
    && measurement.remainingAreaPx <= measurement.baselineAreaPx
    && measurement.geometryId === service.geometryId && measurement.qualityFlags.length === 0;
}

/** One geometry per aggregate; callers must select or group geometries first. */
export function summarize(services: readonly DemoService[]): Summary {
  if (new Set(services.map(service => service.geometryId)).size > 1) throw new Error('Incompatible geometries must be grouped separately.');
  const result: Summary = { remainingAreaPx: 0, baselineAreaPx: 0, wastePercent: null, attendance: null, remainingAreaPxPerSimulatedAttendee: null, capturedDishes: 0, successfulAnalyses: 0, failedAnalyses: 0, reviewAnalyses: 0, excludedMeasurements: 0, assessedServings: 0, averagePlateWastePercent: null, averagedPlates: 0, cleanPlates: 0, excludedPlates: 0, foods: [] };
  let platePercentTotal = 0;
  const foods = new Map<string, FoodTotal>();
  let attendance = 0;
  let attendanceAvailable = services.length > 0;
  for (const service of services) {
    if (Number.isInteger(service.attendance?.count) && service.attendance.count > 0) attendance += service.attendance.count;
    else attendanceAvailable = false;
    for (const capture of service.captures) {
      result.capturedDishes++;
      if (capture.status === 'failed') result.failedAnalyses++;
      if (capture.status === 'needs_review') result.reviewAnalyses++;
      if (capture.status === 'succeeded') result.successfulAnalyses++;
      const validMeasurements = capture.measurements.filter(measurement => eligible(measurement, service));
      const complete = validMeasurements.length === capture.measurements.length;
      const consistent = !capture.emptyPlate || validMeasurements.every(measurement => measurement.remainingAreaPx === 0);
      const validPlate = capture.status === 'succeeded' && complete && consistent
        && (capture.emptyPlate || validMeasurements.length > 0);
      if (validPlate) {
        const baseline = validMeasurements.reduce((total, measurement) => total + measurement.baselineAreaPx!, 0);
        const remaining = validMeasurements.reduce((total, measurement) => total + measurement.remainingAreaPx, 0);
        const percentage = capture.emptyPlate ? 0 : 100 * remaining / baseline;
        platePercentTotal += percentage;
        result.averagedPlates++;
        if (percentage === 0) result.cleanPlates++;
      } else result.excludedPlates++;
      for (const measurement of capture.measurements) {
        if (capture.status !== 'succeeded' || !consistent || !eligible(measurement, service)) {
          result.excludedMeasurements++;
          continue;
        }
        const item = service.items.find(candidate => candidate.id === measurement.itemId)!;
        const food = foods.get(item.id) ?? { id: item.id, name: item.name, remainingAreaPx: 0, baselineAreaPx: 0, assessedServings: 0, wastePercent: null, sharePercent: 0 };
        food.remainingAreaPx += measurement.remainingAreaPx;
        food.baselineAreaPx += measurement.baselineAreaPx!;
        food.assessedServings++;
        foods.set(item.id, food);
        result.remainingAreaPx += measurement.remainingAreaPx;
        result.baselineAreaPx += measurement.baselineAreaPx!;
        result.assessedServings++;
      }
    }
  }
  result.wastePercent = result.baselineAreaPx > 0 ? 100 * result.remainingAreaPx / result.baselineAreaPx : null;
  result.averagePlateWastePercent = result.averagedPlates > 0 ? platePercentTotal / result.averagedPlates : null;
  result.attendance = attendanceAvailable ? attendance : null;
  result.remainingAreaPxPerSimulatedAttendee = result.attendance !== null ? result.remainingAreaPx / result.attendance : null;
  result.foods = [...foods.values()].map(food => ({ ...food, wastePercent: food.baselineAreaPx > 0 ? 100 * food.remainingAreaPx / food.baselineAreaPx : null, sharePercent: result.remainingAreaPx > 0 ? 100 * food.remainingAreaPx / result.remainingAreaPx : 0 })).sort((a, b) => b.remainingAreaPx - a.remainingAreaPx);
  return result;
}

export function filterServices(services: readonly DemoService[], start: string, end: string, hallId?: string): DemoService[] {
  return services.filter(service => service.localDate >= start && service.localDate <= end && (!hallId || service.hallId === hallId));
}

export function groupTrend(services: readonly DemoService[]) {
  const groups = new Map<string, DemoService[]>();
  for (const service of services) {
    const key = service.localDate;
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({ date, start: group.map(service => service.localDate).sort()[0], end: group.map(service => service.localDate).sort().at(-1)!, ...summarize(group) }));
}

export function demoSuggestion(summary: Summary): string {
  const top = summary.foods[0];
  if (!summary.averagedPlates) return 'No reliable plate readings yet. Check the camera before changing portions.';
  if (!top || summary.remainingAreaPx === 0) return 'The checked plates came back clean. Keep checking before changing portions.';
  return `${top.name} made up ${top.sharePercent.toFixed(0)}% of the leftovers. Try a smaller scoop and compare the next meal.`;
}
