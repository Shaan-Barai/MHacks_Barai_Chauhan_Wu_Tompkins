-- Row Level Security for EVERY table in public.
--
--   * Dashboard tables: the anon key and signed-in users may SELECT. These are
--     the tables that were public in SpacetimeDB, plus hall/dish and the
--     forecasting tables.
--   * Private tables (storage paths, raw attempts, device ids, admin state,
--     demo bookkeeping): RLS on with NO policy, so anon/authenticated see
--     nothing. The backend reads them with the service role.
--   * Writes: no INSERT/UPDATE/DELETE policy exists for anon or authenticated,
--     and their write privileges are revoked as a second layer. Only the
--     service role (backend/worker, which bypasses RLS) writes.
--
-- TODO(per-hall access): once dashboard logins exist, replace the
-- `using (true)` read policies with a hall check such as
--   using (hall_id in (select hall_id from public.hall_manager where user_id = auth.uid()))
-- and add matching write policies for hall managers.

do $$
declare
  t text;
  dashboard_tables text[] := array[
    'hall', 'dish',
    'meal_service', 'menu_item', 'menu_item_revision', 'reference_portion', 'capture_event', 'food_measurement',
    'simulated_attendance', 'portions_served', 'insight', 'camera_calibration', 'measurement_settings',
    'menu_cycle', 'production_log', 'attendance', 'context_day', 'forecast', 'forecast_outcome'];
begin
  -- RLS on everything, including any table not listed above.
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', t);
    if t = any(dashboard_tables) then
      execute format('grant select on public.%I to anon, authenticated', t);
      execute format('create policy "dashboard read" on public.%I for select to anon, authenticated using (true)', t);
    else
      execute format('revoke select on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- Identity columns: clients never need sequence access.
revoke usage, select, update on all sequences in schema public from anon, authenticated;

-- Write functions are for the service role only.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- New tables/functions created later start locked down too; each migration
-- still has to enable RLS and add policies explicitly.
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
