/** UI-preview contract. Synthetic records are not live camera/Gemini observations. */
export type Meal = 'breakfast' | 'lunch' | 'dinner';
export type AnalysisStatus = 'succeeded' | 'needs_review' | 'failed';

export interface DemoMeasurement {
  itemId: string | null;
  remainingAreaPx: number;
  baselineAreaPx: number | null;
  baselineId: string | null;
  geometryId: string;
  qualityFlags: string[];
  method: 'demo_ai_estimate';
  isDemo: true;
}

export interface DemoCapture {
  id: string;
  capturedAt: string;
  source: 'demo_replay';
  status: AnalysisStatus;
  emptyPlate: boolean;
  measurements: DemoMeasurement[];
  isDemo: true;
}

export interface DemoService {
  id: string;
  hallId: string;
  localDate: string;
  meal: Meal;
  menuId: string;
  menuVersion: number;
  geometryId: string;
  items: { id: string; name: string; baselineId: string; baselineAreaPx: number }[];
  attendance: {
    count: number;
    source: 'simulated';
    min: number;
    max: number;
    seed: string;
    generatorVersion: string;
  };
  captures: DemoCapture[];
  isDemo: true;
}

export interface DemoDataset {
  schemaVersion: 1;
  source: 'synthetic_ui_fixture';
  isDemo: true;
  hall: { id: string; name: string; timezone: string };
  window: { start: string; end: string; days: number };
  seed: string;
  geometry: { id: string; width: number; height: number; description: string };
  services: DemoService[];
}
