-- Supabase Realtime for the dashboard: new or updated scans and their counted
-- measurements are broadcast so open dashboards refresh without a reload.
-- Realtime applies RLS, so the anon key only receives changes to tables it can
-- read (both of these are dashboard tables). The dashboard refetches its
-- numbers from the backend API on each change; no data is computed in the browser.

alter publication supabase_realtime add table public.capture_event, public.food_measurement;
