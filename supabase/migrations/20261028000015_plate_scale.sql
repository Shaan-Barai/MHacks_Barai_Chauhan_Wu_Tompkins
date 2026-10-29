-- Plate scale (Run 3, Phase 5, plate-scale-v1): one row per analysis attempt
-- with the scanned plate's diameter in pixels (from the AI dish box) and the
-- plate diameter assumed when it was recorded. Pounds are ESTIMATES computed at
-- read time (analytics/src/plateScale.ts); Pixels wasted and food_measurement
-- are unchanged. Additive only. Private: served through the backend.

create table public.plate_scale_estimate (
  attempt_id                text primary key references public.analysis_attempt on delete cascade,
  event_id                  text not null references public.capture_event on delete cascade,
  method                    text not null check (method = 'plate-scale-v1'),
  dish_type                 text,
  fully_visible             boolean,
  plate_diameter_px         double precision check (plate_diameter_px > 0),
  box_width_px              double precision,
  box_height_px             double precision,
  assumed_plate_diameter_cm double precision not null check (assumed_plate_diameter_cm > 0),
  unavailable_reason        text,                       -- why plate_diameter_px is null
  created_at                timestamptz not null default now(),
  check ((plate_diameter_px is null) = (unavailable_reason is not null))
);
create index plate_scale_estimate_event_idx on public.plate_scale_estimate (event_id);

alter table public.plate_scale_estimate enable row level security;
revoke all on public.plate_scale_estimate from anon, authenticated;
