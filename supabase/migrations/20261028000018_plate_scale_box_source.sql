-- Run 4, Task 4: where a plate_scale_estimate's dish box came from. Additive only.
--   'analysis'        the scan's own analysis (pass 1 of its Gemini localization), recorded with it;
--   'backfill-pass1'  a later re-run of ONLY that pass on the same stored photo with the attempt's menu
--                     (backend/scripts/backfill-plate-scale.mjs), for scans analyzed before plate-scale-v1.
--                     The attempt's measurements and Pixels wasted are untouched.
alter table public.plate_scale_estimate add column box_source text not null default 'analysis'
  check (box_source in ('analysis', 'backfill-pass1'));
