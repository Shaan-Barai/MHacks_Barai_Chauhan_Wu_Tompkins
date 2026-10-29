-- Imported history: measurements recorded before the method was renamed carry
-- 'sam2_mask_pixel_count' (all 23 rows in this Mac's SpacetimeDB data). They
-- are kept verbatim so the dashboard computes exactly what it did on
-- SpacetimeDB: current analytics count only 'mask_pixel_count', so these rows
-- stay out of mask-pixel totals there and here alike. New writes still go
-- through record_analysis, which the backend calls with the current names.

alter table public.food_measurement drop constraint food_measurement_method_check;
alter table public.food_measurement add constraint food_measurement_method_check
  check (method in ('mask_pixel_count', 'gemini_area_estimate', 'sam2_mask_pixel_count'));
