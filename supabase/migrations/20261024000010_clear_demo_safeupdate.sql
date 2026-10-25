-- Supabase's API role loads the safeupdate extension, which refuses DELETE and
-- UPDATE statements without a WHERE clause. clear_demo_data's final
-- "delete from demo_marker" therefore failed when called through the API
-- ("DELETE requires a WHERE clause"); it now says "where true" explicitly.

create or replace function public.clear_demo_data() returns integer
language plpgsql set search_path = public as $$
declare v_count integer;
begin
  select count(*) into v_count from public.demo_marker;
  delete from public.food_measurement where measurement_id in (select row_key from public.demo_marker where table_name = 'food_measurement');
  delete from public.capture_count where attempt_id in (select row_key from public.demo_marker where table_name = 'capture_count');
  delete from public.analysis_attempt where attempt_id in (select row_key from public.demo_marker where table_name = 'analysis_attempt');
  delete from public.scan_info where event_id in (select row_key from public.demo_marker where table_name = 'scan_info');
  -- capture_visibility rows of sample scans go with them (cascade).
  delete from public.capture_event where event_id in (select row_key from public.demo_marker where table_name = 'capture_event');
  delete from public.portions_served where record_id in (select row_key from public.demo_marker where table_name = 'portions_served');
  delete from public.menu_item where item_id in (select row_key from public.demo_marker where table_name = 'menu_item');
  -- Simulated attendance generated for a sample service goes with it (cascade).
  delete from public.meal_service where service_id in (select row_key from public.demo_marker where table_name = 'meal_service');
  delete from public.demo_marker where true;
  return v_count;
end $$;

revoke execute on function public.clear_demo_data() from public, anon, authenticated;
grant execute on function public.clear_demo_data() to service_role;
