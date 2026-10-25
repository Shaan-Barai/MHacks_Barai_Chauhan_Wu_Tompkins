-- Forecasting additions (overnight run, Phase 1). All forecasting tables are
-- still empty, so these ALTERs change no data.
--
-- * is_simulated on every forecasting table (and dish): simulated rows are
--   labeled in data, UI and reports, and removable with one command
--   (python -m forecast.simulate remove).
-- * forecast_outcome is keyed by dish x hall x date x meal x model (an outcome
--   can exist for the FSS forecast alone), with the actuals it was scored on.
-- * production_log gets the review fields the production-sheet reader needs:
--   extracted rows start 'unconfirmed' with per-field confidence and flags.
-- * hall.menu_cycle_start: the Monday of cycle week 1, so any date maps to its
--   cycle week (1-6) and weekday.
-- * dish: standard portion, food cost and the factor-table food name used for
--   the Waste Impact Score (factors/menu_waste_factors_*.csv).

-- ---------------------------------------------------------------------------
-- hall / dish
-- ---------------------------------------------------------------------------

alter table public.hall add column menu_cycle_start date
  check (menu_cycle_start is null or extract(isodow from menu_cycle_start) = 1);
alter table public.hall add column menu_cycle_weeks smallint not null default 6 check (menu_cycle_weeks between 1 and 12);

alter table public.dish add column service_style text not null default 'side'
  check (service_style in ('entree', 'side', 'self_serve', 'dessert', 'other'));
alter table public.dish add column portion_lb numeric(6, 3) check (portion_lb > 0);
alter table public.dish add column food_cost_usd_per_lb numeric(8, 2) check (food_cost_usd_per_lb >= 0);
alter table public.dish add column impact_food_name text;          -- the `food` column in the factors CSV
alter table public.dish add column is_simulated boolean not null default false;

-- ---------------------------------------------------------------------------
-- is_simulated everywhere else
-- ---------------------------------------------------------------------------

alter table public.menu_cycle add column is_simulated boolean not null default false;
alter table public.attendance add column is_simulated boolean not null default false;
alter table public.context_day add column is_simulated boolean not null default false;
alter table public.forecast add column is_simulated boolean not null default false;

-- ---------------------------------------------------------------------------
-- production_log: review workflow for sheet extraction
-- ---------------------------------------------------------------------------

alter table public.production_log add column is_simulated boolean not null default false;
alter table public.production_log add column status text not null default 'confirmed'
  check (status in ('unconfirmed', 'confirmed', 'rejected'));
alter table public.production_log add column dish_name_raw text;             -- as written on the sheet
alter table public.production_log add column field_confidence jsonb;         -- { field: 0..1 } from the extractor
alter table public.production_log add column review_flags text[] not null default '{}';
alter table public.production_log add column sheet_image_object_id text references public.image_object;
alter table public.production_log add column extraction_model text;
alter table public.production_log add column updated_at timestamptz not null default now();
-- An unconfirmed row may not have matched a dish yet; a confirmed one must.
alter table public.production_log alter column dish_id drop not null;
alter table public.production_log add constraint production_log_confirmed_dish
  check (status <> 'confirmed' or dish_id is not null);
alter table public.production_log add constraint production_log_confirmed_by
  check (status <> 'confirmed' or source in ('demo', 'csv') or confirmed_by is not null);
alter table public.production_log add constraint production_log_leftover_le_prepped
  check (pan_leftover_lb is null or prepped_lb is null or pan_leftover_lb <= prepped_lb or status = 'unconfirmed');
-- Several unconfirmed extractions of one sheet line may coexist; only confirmed
-- rows must be unique per dish x station x meal.
do $$
declare n text;
begin
  -- The auto-generated name of the original unique (hall, date, meal, dish, station) constraint.
  select conname into strict n from pg_constraint where conrelid = 'public.production_log'::regclass and contype = 'u';
  execute format('alter table public.production_log drop constraint %I', n);
end $$;
create unique index production_log_confirmed_unique on public.production_log
  (hall_id, service_date, meal_label, dish_id, coalesce(station, '')) where status = 'confirmed';
create index production_log_status_idx on public.production_log (status);

-- ---------------------------------------------------------------------------
-- forecast_outcome: one row per dish x hall x date x meal x model
-- ---------------------------------------------------------------------------

alter table public.forecast_outcome drop constraint forecast_outcome_pkey;
alter table public.forecast_outcome add column forecast_outcome_id bigint generated always as identity primary key;
alter table public.forecast_outcome alter column forecast_id drop not null;
alter table public.forecast_outcome add column hall_id text not null references public.hall;
alter table public.forecast_outcome add column service_date date not null;
alter table public.forecast_outcome add column meal_label text not null check (meal_label in ('breakfast', 'lunch', 'dinner'));
alter table public.forecast_outcome add column dish_id text not null references public.dish;
alter table public.forecast_outcome add column model_version text not null;
alter table public.forecast_outcome add column recommended_prep_lb numeric(8, 2);
alter table public.forecast_outcome add column fss_forecast_lb numeric(8, 2);
alter table public.forecast_outcome add column prepped_lb numeric(8, 2);
alter table public.forecast_outcome add column consumed_lb numeric(8, 2);          -- prepped - pan leftover
alter table public.forecast_outcome add column consumed_is_lower_bound boolean not null default false; -- ran out: true demand was higher
alter table public.forecast_outcome add column leftover_cost_usd numeric(10, 2);
alter table public.forecast_outcome add column tray_waste_cost_usd numeric(10, 2);
alter table public.forecast_outcome add column tray_waste_source text
  check (tray_waste_source is null or tray_waste_source in ('calibrated_scans', 'simulated'));
alter table public.forecast_outcome add column is_simulated boolean not null default false;
alter table public.forecast_outcome add constraint forecast_outcome_key unique (hall_id, service_date, meal_label, dish_id, model_version);
create index forecast_outcome_hall_date_idx on public.forecast_outcome (hall_id, service_date);
create index forecast_outcome_dish_idx on public.forecast_outcome (dish_id);
create trigger forecast_outcome_ensure_hall before insert or update of hall_id on public.forecast_outcome
  for each row execute function public.ensure_hall();

-- Simulated-row indexes keep "remove simulated data" cheap.
create index production_log_simulated_idx on public.production_log (is_simulated) where is_simulated;
create index forecast_simulated_idx on public.forecast (is_simulated) where is_simulated;
create index forecast_outcome_simulated_idx on public.forecast_outcome (is_simulated) where is_simulated;
create index attendance_simulated_idx on public.attendance (is_simulated) where is_simulated;
