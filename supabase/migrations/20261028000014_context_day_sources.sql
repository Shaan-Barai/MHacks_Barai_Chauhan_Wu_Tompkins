-- Real, sourced context (Run 3, Phase 3). Additive only: every row keeps the
-- URL of each source it was built from; academic-calendar flags beside the
-- existing exam_week / home_game / is_holiday. Simulated rows are untouched.

alter table public.context_day add column source_urls jsonb not null default '{}'::jsonb;  -- {"academic": url, "football": url, "weather": url, "holidays": [url, ...]}
alter table public.context_day add column academic_note text;                    -- e.g. 'Fall study break'
alter table public.context_day add column class_day boolean;                     -- regular classes held (null = unknown)
alter table public.context_day add column study_day boolean not null default false;
alter table public.context_day add column break_day boolean not null default false;
alter table public.context_day add column first_class_day boolean not null default false;
alter table public.context_day add column weather_kind text check (weather_kind in ('observed', 'forecast'));
alter table public.context_day add column imported_at timestamptz;
