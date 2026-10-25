-- Scrap Saver core schema: one table per former SpacetimeDB table
-- (db/spacetimedb/src/schema.ts), plus `hall` and `dish` as foreign-key targets.
--
-- Representation (contracts/types.ts is still the source of truth for shapes):
--   * Contract string unions are text columns with CHECK constraints.
--   * Contract UTC ISO strings are timestamptz; local service dates are date.
--     The backend adapter converts both back to the contract's ISO strings.
--   * Small nested records (errors, intrinsics, physical estimates, calibration)
--     are jsonb; string lists are text[].
--   * IMAGE BYTES ARE NEVER STORED HERE. image_object keeps the storage path
--     (container + object_key) and metadata; bytes live in Supabase Storage.
--   * Columns marked LEGACY were unused in SpacetimeDB too (removed depth trial).
--     They are kept so the one-time copy is lossless and can be dropped later.
--
-- The simulated per-service attendance table is renamed simulated_attendance;
-- `attendance` holds real 15-minute swipe counts (forecasting migration).

-- ---------------------------------------------------------------------------
-- Foreign-key targets
-- ---------------------------------------------------------------------------

create table public.hall (
  hall_id      text primary key check (hall_id <> ''),
  timezone     text,                       -- IANA name, filled from meal_service
  display_name text,
  created_at   timestamptz not null default now()
);
comment on table public.hall is 'One row per dining hall. Rows are created automatically by the ensure_hall triggers.';

-- Stable dish identity across cycle days (menu_item ids are per hall/date/meal).
create table public.dish (
  dish_id      text primary key check (dish_id ~ '^[a-z0-9][a-z0-9_-]*$'),
  display_name text not null,
  category     text,
  created_at   timestamptz not null default now()
);

-- Creates the hall row on first use, so writes never fail on a new hall id.
create function public.ensure_hall() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.hall (hall_id) values (new.hall_id) on conflict (hall_id) do nothing;
  return new;
end $$;

-- meal_service also records the hall's timezone the first time it is known.
create function public.ensure_hall_with_timezone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.hall (hall_id, timezone) values (new.hall_id, new.hall_timezone)
  on conflict (hall_id) do update set timezone = coalesce(public.hall.timezone, excluded.timezone);
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Menus
-- ---------------------------------------------------------------------------

create table public.meal_service (
  service_id    text primary key,          -- svc_<hallId>_<date>_<meal>
  hall_id       text not null references public.hall,
  hall_timezone text not null,
  service_date  date not null,             -- LOCAL date in hall_timezone
  meal_label    text not null check (meal_label in ('breakfast', 'lunch', 'dinner')),
  menu_id       text not null,
  menu_version  integer not null check (menu_version >= 1)
);
create index meal_service_hall_date_idx on public.meal_service (hall_id, service_date);
create index meal_service_menu_idx on public.meal_service (menu_id);
create trigger meal_service_ensure_hall before insert or update of hall_id on public.meal_service
  for each row execute function public.ensure_hall_with_timezone();

-- Live version of each menu (the classification vocabulary).
create table public.menu_item (
  item_id      text primary key,           -- item_<hallId>_<date>_<meal>_<slug>
  menu_id      text not null,
  display_name text not null,
  category     text,
  description  text,
  dish_id      text references public.dish  -- forecasting link; null until mapped
);
create index menu_item_menu_idx on public.menu_item (menu_id);
create index menu_item_dish_idx on public.menu_item (dish_id);

-- Items of superseded menu versions, so old measurements still resolve names. Insert-only.
create table public.menu_item_revision (
  revision_item_id text primary key,       -- <itemId>@v<menuVersion>
  item_id          text not null,
  menu_id          text not null,
  menu_version     integer not null,
  display_name     text not null,
  category         text,
  description      text,
  superseded_at    timestamptz not null
);
create index menu_item_revision_item_idx on public.menu_item_revision (item_id);
create index menu_item_revision_menu_idx on public.menu_item_revision (menu_id);

-- ---------------------------------------------------------------------------
-- Images (references + metadata only)
-- ---------------------------------------------------------------------------

create table public.image_object (
  object_id        text primary key,
  provider         text not null,          -- 'supabase' | 'r2' (legacy) | 'local-dev'
  container        text not null,          -- bucket
  object_key       text not null,          -- storage path; never an expiring URL
  public_url       text,
  mime_type        text not null,
  size_bytes       bigint not null check (size_bytes >= 0),
  width_px         integer,
  height_px        integer,
  uploaded_at      timestamptz,
  -- 'capture' | 'original' | 'reference' | 'mask' | 'overlay' | 'calibration'
  -- | 'calibration_overlay' | 'production_sheet' | legacy 'depth'
  association_kind text not null,
  association_id   text not null,
  state            text not null check (state in ('pending_upload', 'uploaded', 'finalized', 'failed', 'orphaned'))
);
create index image_object_association_idx on public.image_object (association_id);
create index image_object_state_idx on public.image_object (state);
create index image_object_key_idx on public.image_object (container, object_key);

-- Baselines are append-only versions; a missing baseline is the absence of a row.
create table public.reference_portion (
  baseline_id                text primary key,
  baseline_version           integer not null check (baseline_version >= 1),
  item_id                    text not null,
  expected_area_px           double precision not null check (expected_area_px > 0 and expected_area_px < 'Infinity'),
  geometry                   jsonb not null,
  source                     text not null check (source in ('reference_photo', 'manual_area', 'gemini_estimate')),
  reference_image_object_id  text references public.image_object
);
create index reference_portion_item_idx on public.reference_portion (item_id);

-- ---------------------------------------------------------------------------
-- Captures and analysis
-- ---------------------------------------------------------------------------

-- event_id is the ingestion idempotency key: retries update this row.
create table public.capture_event (
  event_id          text primary key,
  hall_id           text not null references public.hall,
  service_id        text not null references public.meal_service,
  captured_at       timestamptz not null,
  image_object_id   text not null references public.image_object,
  -- contracts ImageGeometry, flattened so compatible geometries group in SQL
  width_px          integer not null check (width_px > 0),
  height_px         integer not null check (height_px > 0),
  coordinate_space  text not null,
  plate_shape       text,
  plate_diameter_px double precision,
  source            text not null check (source in ('camera', 'replay', 'manual_upload', 'demo')),
  quality_flags     text[] not null default '{}',
  state             text not null check (state in ('pending', 'processing', 'succeeded', 'needs_review', 'failed'))
);
create index capture_event_hall_time_idx on public.capture_event (hall_id, captured_at);
create index capture_event_service_idx on public.capture_event (service_id);
create index capture_event_state_idx on public.capture_event (state);
create trigger capture_event_ensure_hall before insert or update of hall_id on public.capture_event
  for each row execute function public.ensure_hall();

create table public.camera_calibration (
  calibration_id             text primary key,
  hall_id                    text not null references public.hall,
  camera_id                  text not null,
  created_at                 timestamptz not null,
  status                     text not null check (status in ('processing', 'succeeded', 'failed')),
  method                     text not null,          -- 'reference-area-v1'
  image_object_id            text not null references public.image_object,
  overlay_object_id          text references public.image_object,
  reference_mask_object_id   text references public.image_object,
  width_px                   integer not null check (width_px > 0),
  height_px                  integer not null check (height_px > 0),
  known_area_cm2             double precision not null check (known_area_cm2 > 0),
  reference_label            text not null,
  reference_pixels           integer not null check (reference_pixels >= 0),
  cm2_per_px                 double precision not null check (cm2_per_px >= 0),
  intrinsics                 jsonb not null,
  camera_height_cm_geometric double precision not null,
  depth                      jsonb,                  -- LEGACY, always null for new rows
  flags                      text[] not null default '{}',
  error                      jsonb
);
create index camera_calibration_hall_idx on public.camera_calibration (hall_id);
create trigger camera_calibration_ensure_hall before insert or update of hall_id on public.camera_calibration
  for each row execute function public.ensure_hall();

-- Append-only per capture event; freezes menu/baseline versions used.
create table public.analysis_attempt (
  attempt_id        text primary key,
  event_id          text not null references public.capture_event on delete cascade,
  menu_id           text not null,
  menu_version      integer not null,
  baseline_versions jsonb not null default '{}',      -- { itemId: baselineVersion }
  model             text not null,
  prompt_version    text not null,
  status            text not null check (status in ('succeeded', 'needs_review', 'failed')),
  error             jsonb,                             -- contracts ApiError
  quality_flags     text[] not null default '{}',
  created_at        timestamptz not null,
  calibration_id    text references public.camera_calibration,
  physical_method   text,
  depth_object_id   text                               -- LEGACY, always null
);
create index analysis_attempt_event_idx on public.analysis_attempt (event_id);

create table public.food_measurement (
  measurement_id        text primary key,
  event_id              text not null references public.capture_event on delete cascade,
  attempt_id            text not null references public.analysis_attempt on delete cascade,
  -- null = unknown/unclassified food. No FK: items of superseded menu
  -- versions live in menu_item_revision.
  item_id               text,
  remaining_area_px     double precision not null check (remaining_area_px >= 0 and remaining_area_px < 'Infinity'),
  baseline_id           text,
  baseline_area_px      double precision check (baseline_area_px > 0),
  raw_waste_fraction    double precision,
  display_waste_percent double precision,
  unavailable_reason    text,
  method                text not null check (method in ('mask_pixel_count', 'gemini_area_estimate')),
  mask_count            jsonb,                         -- small validated count/provenance; no mask bytes
  quality_flags         text[] not null default '{}',
  physical              jsonb                          -- estimated calibrated area; null = none
);
create index food_measurement_event_idx on public.food_measurement (event_id);
create index food_measurement_attempt_idx on public.food_measurement (attempt_id);
create index food_measurement_item_idx on public.food_measurement (item_id);

-- Segmentation stage + Pixels wasted per attempt (union of valid masks).
create table public.capture_count (
  attempt_id            text primary key references public.analysis_attempt on delete cascade,
  event_id              text not null references public.capture_event on delete cascade,
  model                 text not null,
  checkpoint            text not null,
  code_revision         text not null,
  prompt_source         text not null,
  settings_version      text not null,
  counting_rule_version text not null,
  status                text not null check (status in ('succeeded', 'partial', 'failed', 'skipped')),
  count_status          text not null check (count_status in ('complete', 'empty', 'partial', 'unavailable')),
  capture_pixels_wasted integer check (capture_pixels_wasted >= 0),
  width_px              integer not null check (width_px > 0),
  height_px             integer not null check (height_px > 0),
  check (capture_pixels_wasted is null or capture_pixels_wasted::bigint <= width_px::bigint * height_px),
  check ((count_status = 'unavailable') = (capture_pixels_wasted is null)),
  check (count_status <> 'empty' or capture_pixels_wasted = 0)
);
create index capture_count_event_idx on public.capture_count (event_id);

create table public.segmentation_region (
  region_id           text primary key,
  attempt_id          text not null references public.analysis_attempt on delete cascade,
  event_id            text not null references public.capture_event on delete cascade,
  item_id             text,                -- null = unclassified edible food
  visual_label        text not null,
  gemini_box          double precision[] not null check (cardinality(gemini_box) = 4),  -- [ymin,xmin,ymax,xmax] 0-1000
  pixel_box           double precision[] not null check (cardinality(pixel_box) = 4),   -- [x0,y0,x1,y1]
  box_convention      text not null,
  segmentation_status text not null check (segmentation_status in ('succeeded', 'failed', 'skipped')),
  mask_object_id      text references public.image_object,
  mask_pixels         integer check (mask_pixels >= 0),
  score               double precision,
  error               jsonb
);
create index segmentation_region_attempt_idx on public.segmentation_region (attempt_id);
create index segmentation_region_event_idx on public.segmentation_region (event_id);
create index segmentation_region_item_idx on public.segmentation_region (item_id);

-- Per-attempt overlay reference (calibration is deprecated and left null).
create table public.attempt_calibration (
  attempt_id        text primary key references public.analysis_attempt on delete cascade,
  event_id          text not null references public.capture_event on delete cascade,
  calibration       jsonb,
  overlay_object_id text references public.image_object
);
create index attempt_calibration_event_idx on public.attempt_calibration (event_id);

create table public.measurement_settings (
  hall_id               text primary key references public.hall,
  depth_enabled         boolean not null default false,       -- LEGACY, always false
  active_calibration_id text references public.camera_calibration,
  plate_thickness_cm    double precision not null default 0,  -- LEGACY, always 0
  updated_at            timestamptz not null
);
create trigger measurement_settings_ensure_hall before insert or update of hall_id on public.measurement_settings
  for each row execute function public.ensure_hall();

-- ---------------------------------------------------------------------------
-- Service-level records
-- ---------------------------------------------------------------------------

-- SIMULATED attendance (one per service, never regenerated per request).
-- Was `attendance` in SpacetimeDB.
create table public.simulated_attendance (
  service_id        text primary key references public.meal_service on delete cascade,
  hall_id           text not null references public.hall,
  service_date      date not null,
  count             integer not null check (count >= 0),
  source            text not null default 'simulated' check (source = 'simulated'),
  configured_min    integer not null,
  configured_max    integer not null,
  seed              text,
  generator_version text not null
);
create index simulated_attendance_hall_date_idx on public.simulated_attendance (hall_id, service_date);
create trigger simulated_attendance_ensure_hall before insert or update of hall_id on public.simulated_attendance
  for each row execute function public.ensure_hall();

-- Replacement snapshots per service + menu version (never additive).
create table public.portions_served (
  record_id    text primary key,           -- JSON [serviceId, menuVersion, itemId]
  service_id   text not null references public.meal_service on delete cascade,
  hall_id      text not null references public.hall,
  service_date date not null,
  menu_id      text not null,
  menu_version integer not null,
  item_id      text not null,
  count        integer not null check (count >= 0),
  source       text not null check (source in ('manual', 'csv', 'demo')),
  updated_at   timestamptz not null,
  unique (service_id, menu_version, item_id)
);
create index portions_served_hall_date_idx on public.portions_served (hall_id, service_date);
create index portions_served_item_idx on public.portions_served (item_id);
create trigger portions_served_ensure_hall before insert or update of hall_id on public.portions_served
  for each row execute function public.ensure_hall();

create table public.insight (
  insight_id     text primary key,
  hall_id        text not null references public.hall,
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  metrics        jsonb not null default '{}',
  data_version   text not null,
  recommendation text not null,
  source         text not null,            -- 'gemini' | 'fallback_rules'
  generated_at   timestamptz not null
);
create index insight_hall_generated_idx on public.insight (hall_id, generated_at);
create trigger insight_ensure_hall before insert or update of hall_id on public.insight
  for each row execute function public.ensure_hall();

-- ---------------------------------------------------------------------------
-- Admin curation, scan details, demo bookkeeping
-- ---------------------------------------------------------------------------

-- No row = shown. Hiding never deletes the capture or its images.
create table public.capture_visibility (
  event_id   text primary key references public.capture_event on delete cascade,
  hidden     boolean not null,
  updated_at timestamptz not null
);

-- "Clear data" cutoff per hall; nothing is deleted.
create table public.dashboard_view (
  hall_id    text primary key references public.hall,
  cleared_at timestamptz,
  updated_at timestamptz not null
);
create trigger dashboard_view_ensure_hall before insert or update of hall_id on public.dashboard_view
  for each row execute function public.ensure_hall();

create table public.scan_info (
  event_id                 text primary key references public.capture_event on delete cascade,
  device_id                text not null,
  timestamp_basis          text not null check (timestamp_basis in ('laptop_trigger', 'laptop_received', 'laptop_ingest', 'demo')),
  original_image_object_id text references public.image_object,
  original_sha256          text check (original_sha256 ~ '^[0-9a-f]{64}$'),
  source_name              text,
  demo                     boolean not null default false
);

-- Every row the demo-history seed creates, so clear_demo_data removes only those.
create table public.demo_marker (
  marker_id  text primary key,             -- <tableName>:<rowKey>
  table_name text not null check (table_name in (
    'meal_service', 'menu_item', 'portions_served', 'capture_event', 'scan_info',
    'analysis_attempt', 'food_measurement', 'capture_count')),
  row_key    text not null
);
create index demo_marker_table_idx on public.demo_marker (table_name);
