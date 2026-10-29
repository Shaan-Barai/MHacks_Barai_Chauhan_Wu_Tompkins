-- Model comparison results (Run 3, Phase 6): one row per backtest run x model x mode,
-- written by `python -m forecast.backtest --write`. Additive only. is_simulated marks
-- runs built from simulated rows; the dashboard shows those under a SIMULATED banner.
-- Dashboard-readable (no personal data), like forecast / forecast_outcome.

create table public.forecast_model_comparison (
  run_id            text not null,
  hall_id           text not null references public.hall,
  window_start      date not null,
  window_end        date not null,
  model_version     text not null,
  mode              text not null check (mode in ('default', 'matched_stockouts', 'as_given')),
  meals             integer not null check (meals >= 0),
  censored_meals    integer not null check (censored_meals >= 0),
  wape              double precision,
  bias              double precision,
  stockouts         integer not null check (stockouts >= 0),
  leftover_lb       double precision,
  leftover_usd      double precision,
  interval_coverage double precision check (interval_coverage between 0 and 1),
  mean_q            double precision,
  q_shift           double precision,
  comparison_label  text,
  is_simulated      boolean not null,
  generated_at      timestamptz not null default now(),
  notes             jsonb not null default '[]'::jsonb,
  primary key (run_id, model_version, mode)
);
create index forecast_model_comparison_hall_idx on public.forecast_model_comparison (hall_id, generated_at desc);

alter table public.forecast_model_comparison enable row level security;
revoke insert, update, delete, truncate, references, trigger on public.forecast_model_comparison from anon, authenticated;
grant select on public.forecast_model_comparison to anon, authenticated;
create policy "dashboard read" on public.forecast_model_comparison for select to anon, authenticated using (true);
