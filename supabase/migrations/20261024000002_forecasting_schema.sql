-- Forecasting workflow tables (empty for now; created here so we migrate once).
--
-- Dishes are identified by dish.dish_id, which stays the same across cycle
-- days (menu_item ids are per hall/date/meal). Weights in pounds come from
-- staff-entered production records. Tray waste is measured in pixels; there is
-- no pixel-to-pound conversion yet, so tray_waste_lb stays null until one is
-- defined (AGENTS.md §2: never present pixel area as mass without one).

-- Which dish is served on each day of the 6-week menu cycle.
create table public.menu_cycle (
  menu_cycle_id bigint generated always as identity primary key,
  hall_id       text not null references public.hall,
  cycle_week    smallint not null check (cycle_week between 1 and 6),
  weekday       smallint not null check (weekday between 1 and 7),   -- ISO: 1 = Monday
  meal_label    text not null check (meal_label in ('breakfast', 'lunch', 'dinner')),
  dish_id       text not null references public.dish,
  station       text,
  unique (hall_id, cycle_week, weekday, meal_label, dish_id)
);
create index menu_cycle_dish_idx on public.menu_cycle (dish_id);
create trigger menu_cycle_ensure_hall before insert or update of hall_id on public.menu_cycle
  for each row execute function public.ensure_hall();

-- What the kitchen actually prepared, per dish x station x meal.
create table public.production_log (
  production_log_id bigint generated always as identity primary key,
  hall_id           text not null references public.hall,
  service_date      date not null,
  meal_label        text not null check (meal_label in ('breakfast', 'lunch', 'dinner')),
  service_id        text references public.meal_service,
  dish_id           text not null references public.dish,
  station           text,
  prepped_lb        numeric(8, 2) check (prepped_lb >= 0),
  prepped_portions  integer check (prepped_portions >= 0),
  pan_leftover_lb   numeric(8, 2) check (pan_leftover_lb >= 0),
  ran_out_at        timestamptz,
  source            text not null check (source in ('manual', 'sheet_photo', 'csv', 'demo')),
  sheet_photo_path  text,                  -- Storage path in the private bucket, never image data
  confirmed_by      text,
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique nulls not distinct (hall_id, service_date, meal_label, dish_id, station)
);
create index production_log_hall_date_idx on public.production_log (hall_id, service_date);
create index production_log_dish_idx on public.production_log (dish_id);
create trigger production_log_ensure_hall before insert or update of hall_id on public.production_log
  for each row execute function public.ensure_hall();

-- Real meal-swipe counts in 15-minute intervals (not simulated).
create table public.attendance (
  hall_id        text not null references public.hall,
  interval_start timestamptz not null,
  service_date   date not null,
  meal_label     text not null check (meal_label in ('breakfast', 'lunch', 'dinner')),
  swipe_count    integer not null check (swipe_count >= 0),
  source         text not null default 'swipes',
  primary key (hall_id, interval_start),
  check (date_trunc('minute', interval_start) = interval_start
         and extract(minute from interval_start)::int % 15 = 0)
);
create index attendance_hall_date_meal_idx on public.attendance (hall_id, service_date, meal_label);
create trigger attendance_ensure_hall before insert or update of hall_id on public.attendance
  for each row execute function public.ensure_hall();

-- Things that change demand on a given day.
create table public.context_day (
  hall_id         text not null references public.hall,
  service_date    date not null,
  weather_summary text,
  temp_high_f     numeric(5, 1),
  precip_in       numeric(5, 2) check (precip_in >= 0),
  exam_week       boolean not null default false,
  home_game       boolean not null default false,
  is_holiday      boolean not null default false,
  holiday_name    text,
  events_note     text,
  updated_at      timestamptz not null default now(),
  primary key (hall_id, service_date)
);
create index context_day_date_idx on public.context_day (service_date);
create trigger context_day_ensure_hall before insert or update of hall_id on public.context_day
  for each row execute function public.ensure_hall();

-- One forecast per dish x future meal x model version.
create table public.forecast (
  forecast_id         bigint generated always as identity primary key,
  hall_id             text not null references public.hall,
  service_date        date not null,
  meal_label          text not null check (meal_label in ('breakfast', 'lunch', 'dinner')),
  dish_id             text not null references public.dish,
  expected_diners     integer check (expected_diners >= 0),
  take_rate           numeric(5, 4) check (take_rate between 0 and 1),
  expected_eaten_lb   numeric(8, 2) check (expected_eaten_lb >= 0),
  recommended_prep_lb numeric(8, 2) check (recommended_prep_lb >= 0),
  low_lb              numeric(8, 2) check (low_lb >= 0),
  high_lb             numeric(8, 2) check (high_lb >= 0),
  fss_forecast_lb     numeric(8, 2) check (fss_forecast_lb >= 0),  -- the existing system's forecast, for comparison
  model_version       text not null,
  generated_at        timestamptz not null default now(),
  check (low_lb is null or high_lb is null or low_lb <= high_lb),
  unique (hall_id, service_date, meal_label, dish_id, model_version)
);
create index forecast_hall_date_idx on public.forecast (hall_id, service_date);
create index forecast_dish_idx on public.forecast (dish_id);
create trigger forecast_ensure_hall before insert or update of hall_id on public.forecast
  for each row execute function public.ensure_hall();

-- How a forecast turned out once the meal happened.
create table public.forecast_outcome (
  forecast_id        bigint primary key references public.forecast on delete cascade,
  error_lb           numeric(8, 2),        -- recommended prep minus actual eaten (positive = over-prepped)
  fss_error_lb       numeric(8, 2),        -- same, for the existing system's forecast
  ours_better        boolean generated always as (abs(error_lb) < abs(fss_error_lb)) stored,
  ran_out            boolean,
  pan_leftover_lb    numeric(8, 2) check (pan_leftover_lb >= 0),
  tray_pixels_wasted bigint check (tray_pixels_wasted >= 0),  -- measured: Pixels wasted from tray scans
  tray_waste_lb      numeric(8, 2) check (tray_waste_lb >= 0), -- null until a pixel-to-pound conversion exists
  evaluated_at       timestamptz not null default now()
);
