-- Menu items keep the order they were uploaded in (SpacetimeDB returned them in
-- insertion order, and the Menus page lists them that way). Also fixes
-- upsert_menu so a re-upload keeps each surviving item's dish_id link.

alter table public.menu_item add column position integer;
create index menu_item_menu_position_idx on public.menu_item (menu_id, position);

create or replace function public.upsert_menu(p_menu jsonb) returns void
language plpgsql set search_path = public as $$
declare
  s jsonb := p_menu -> 'service';
  v_service_id text; v_menu_id text; v_version integer;
  existing public.meal_service;
  item jsonb;
  pos bigint;
  dish_links jsonb;
  v_exists boolean;
begin
  if s is null or jsonb_typeof(s) <> 'object' then raise exception 'menu.service is required'; end if;
  if jsonb_typeof(p_menu -> 'items') is distinct from 'array' then raise exception 'menu.items must be an array'; end if;
  v_service_id := _req_text(s, 'serviceId', 'service');
  v_menu_id := _req_text(s, 'menuId', 'service');
  v_version := _req_num(s, 'menuVersion', 'service', 1)::integer;

  select * into existing from public.meal_service where service_id = v_service_id for update;
  v_exists := found;
  -- Keep forecasting's dish links for items that survive a re-upload.
  select coalesce(jsonb_object_agg(item_id, dish_id), '{}') into dish_links
  from public.menu_item where menu_id in (v_menu_id, coalesce(existing.menu_id, v_menu_id)) and dish_id is not null;
  if v_exists then
    if v_version < existing.menu_version then
      raise exception 'menu % version % is older than the stored version %; plan a revision instead',
        v_menu_id, v_version, existing.menu_version;
    end if;
    if v_version > existing.menu_version then
      insert into public.menu_item_revision
        (revision_item_id, item_id, menu_id, menu_version, display_name, category, description, superseded_at)
      select mi.item_id || '@v' || existing.menu_version, mi.item_id, mi.menu_id, existing.menu_version,
             mi.display_name, mi.category, mi.description, now()
      from public.menu_item mi where mi.menu_id = existing.menu_id
      on conflict (revision_item_id) do nothing;
    end if;
    delete from public.menu_item where menu_id = existing.menu_id;
  end if;

  insert into public.meal_service (service_id, hall_id, hall_timezone, service_date, meal_label, menu_id, menu_version)
  values (v_service_id, _req_text(s, 'hallId', 'service'), _req_text(s, 'hallTimezone', 'service'),
          _req_text(s, 'serviceDate', 'service')::date, _req_text(s, 'mealLabel', 'service'), v_menu_id, v_version)
  on conflict (service_id) do update set
    hall_id = excluded.hall_id, hall_timezone = excluded.hall_timezone, service_date = excluded.service_date,
    meal_label = excluded.meal_label, menu_id = excluded.menu_id, menu_version = excluded.menu_version;

  delete from public.menu_item where menu_id = v_menu_id;
  for item, pos in select * from jsonb_array_elements(p_menu -> 'items') with ordinality loop
    if _req_text(item, 'menuId', 'item') <> v_menu_id then
      raise exception 'item % belongs to menu %', item ->> 'itemId', item ->> 'menuId';
    end if;
    insert into public.menu_item (item_id, menu_id, display_name, category, description, position, dish_id)
    values (_req_text(item, 'itemId', 'item'), v_menu_id, _req_text(item, 'displayName', 'item'),
            _opt_text(item, 'category'), _opt_text(item, 'description'), pos::integer, dish_links ->> (item ->> 'itemId'));
  end loop;
end $$;

-- Recreated functions keep their grants, but restate them for clarity.
revoke execute on function public.upsert_menu(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_menu(jsonb) to service_role;
