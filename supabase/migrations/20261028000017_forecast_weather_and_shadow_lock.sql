-- Run 4, Task 3: honest backtests and shadow mode. Additive only.
--
-- 1. Weather FORECASTS beside observed weather on context_day. The existing
--    temp_high_f / precip_in / weather_summary stay the observed (or, for
--    future days, latest-forecast) values; backtests must read only fc_*,
--    which hold what was forecast AT LEAST fc_lead_hours before each hour of
--    the day (Open-Meteo Previous Runs API, `_previous_day1` = 24 h ahead),
--    so they were known before the day's first service.
--
-- 2. Shadow mode: every forecast row gets created_at (set by the database,
--    never by the client) and locks_at (when that meal's service starts, in
--    the hall's time zone). After locks_at the row cannot be updated, and a
--    real (non-simulated) row cannot be deleted. A forecast written after its
--    service started is kept but is not a "locked" forecast (created_at >=
--    locks_at); the shadow report leaves it out.
--    Rows that existed before this migration get created_at = generated_at and
--    lock_tracked = false: they may have been revised after their service, so
--    the report never counts them as locked.

-- ---------------------------------------------------------------------------
-- 1. Forecast weather
-- ---------------------------------------------------------------------------

alter table public.context_day add column fc_temp_high_f numeric(5, 1);
alter table public.context_day add column fc_precip_in   numeric(5, 2) check (fc_precip_in >= 0);
alter table public.context_day add column fc_lead_hours  smallint check (fc_lead_hours > 0);
alter table public.context_day add column fc_source      text check (fc_source in ('open-meteo-previous-runs', 'simulated'));
alter table public.context_day add column fc_source_url  text;
alter table public.context_day add column fc_fetched_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Shadow mode
-- ---------------------------------------------------------------------------

-- When each meal's service starts (local time). Must match forecast/config.toml [meals]
-- (a forecast test checks this file against it).
create table public.meal_service_start (
  meal_label   text primary key check (meal_label in ('breakfast', 'lunch', 'dinner')),
  starts_local time not null
);
insert into public.meal_service_start values ('breakfast', '07:00'), ('lunch', '11:00'), ('dinner', '16:30');
alter table public.meal_service_start enable row level security;
revoke all on public.meal_service_start from anon, authenticated;

create function public.forecast_lock_time(p_hall_id text, p_service_date date, p_meal_label text)
returns timestamptz
language sql stable security definer set search_path = public
as $$
  select (p_service_date + s.starts_local) at time zone coalesce(h.timezone, 'America/Detroit')
  from public.meal_service_start s
  left join public.hall h on h.hall_id = p_hall_id
  where s.meal_label = p_meal_label
$$;

alter table public.forecast add column created_at   timestamptz;
alter table public.forecast add column locks_at     timestamptz;
alter table public.forecast add column lock_tracked boolean not null default true;

-- Existing rows (written before shadow mode): fill the new columns, never counted as locked.
update public.forecast
   set created_at = generated_at,
       locks_at = public.forecast_lock_time(hall_id, service_date, meal_label),
       lock_tracked = false;

alter table public.forecast alter column created_at set default now();
alter table public.forecast alter column created_at set not null;
alter table public.forecast alter column locks_at set not null;
create index forecast_locks_at_idx on public.forecast (locks_at);

create function public.forecast_shadow_lock()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();  -- the database's clock, so a row cannot be backdated
    new.locks_at := public.forecast_lock_time(new.hall_id, new.service_date, new.meal_label);
    if new.locks_at is null then
      raise exception 'no service start time for meal %', new.meal_label using errcode = 'check_violation';
    end if;
    new.lock_tracked := true;
    return new;
  end if;

  if now() >= old.locks_at then
    -- Simulated rows stay removable (python -m forecast.simulate remove); real ones are kept.
    if tg_op = 'DELETE' and old.is_simulated then
      return old;
    end if;
    raise exception 'forecast % is locked: its service started at %', old.forecast_id, old.locks_at
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  if (new.hall_id, new.service_date, new.meal_label) is distinct from (old.hall_id, old.service_date, old.meal_label) then
    raise exception 'forecast % cannot be moved to another service', old.forecast_id using errcode = 'check_violation';
  end if;
  new.created_at := old.created_at;
  new.locks_at := old.locks_at;
  new.lock_tracked := old.lock_tracked;
  return new;
end
$$;

create trigger forecast_shadow_lock before insert or update or delete on public.forecast
  for each row execute function public.forecast_shadow_lock();

revoke execute on function public.forecast_lock_time(text, date, text) from public, anon, authenticated;
revoke execute on function public.forecast_shadow_lock() from public, anon, authenticated;
