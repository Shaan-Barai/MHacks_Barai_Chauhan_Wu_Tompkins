-- Each forecast keeps what it was built from, so prep sheets and the dashboard
-- can say WHY (overnight Phase 3/4). forecast is still empty: no data changes.

alter table public.forecast add column demand_lb numeric(8, 2) check (demand_lb >= 0); -- before the prep buffer
alter table public.forecast add column service_level_q numeric(4, 3) check (service_level_q > 0 and service_level_q < 1);
alter table public.forecast add column basis text;   -- last_cycle | last_cycle_ran_out | dish_weekday_meal_avg | dish_meal_avg | hall_weekday_meal_avg | fss
alter table public.forecast add column why text;     -- one plain-language line for the prep sheet
