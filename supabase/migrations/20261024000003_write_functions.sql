-- Multi-row writes as Postgres functions, ported from the SpacetimeDB reducers
-- (db/spacetimedb/src/reducers.ts). Each call is one transaction, like a
-- reducer call. Arguments are the contract entities as jsonb (camelCase,
-- contracts/types.ts); error messages match the reducers' so the backend maps
-- them to the same API errors.
--
-- Single-row upserts (image_object, capture_event, reference_portion,
-- simulated_attendance, insight, scan_info, dashboard_view, demo_marker) are
-- plain upserts from the backend; their invariants are CHECK constraints.
--
-- Only the service role may execute these (see the RLS migration). No network
-- I/O happens here: Gemini and Storage calls stay in the backend.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

create function public._req_text(o jsonb, key text, what text) returns text
language plpgsql immutable set search_path = public as $$
declare v text;
begin
  if jsonb_typeof(o -> key) is distinct from 'string' or (o ->> key) = '' then
    raise exception '%.% must be a non-empty string', what, key;
  end if;
  return o ->> key;
end $$;

create function public._req_num(o jsonb, key text, what text, min_value double precision default 0, exclusive boolean default false)
returns double precision
language plpgsql immutable set search_path = public as $$
declare v double precision;
begin
  if jsonb_typeof(o -> key) is distinct from 'number' then
    raise exception '%.% must be a finite number % %', what, key, case when exclusive then '>' else '>=' end, min_value;
  end if;
  v := (o ->> key)::double precision;
  if (exclusive and v <= min_value) or (not exclusive and v < min_value) then
    raise exception '%.% must be a finite number % %', what, key, case when exclusive then '>' else '>=' end, min_value;
  end if;
  return v;
end $$;

create function public._opt_text(o jsonb, key text) returns text
language sql immutable as $$
  select case when jsonb_typeof(o -> key) = 'string' then o ->> key end
$$;

create function public._opt_num(o jsonb, key text) returns double precision
language sql immutable as $$
  select case when jsonb_typeof(o -> key) = 'number' then (o ->> key)::double precision end
$$;

create function public._text_array(o jsonb, key text) returns text[]
language sql immutable as $$
  select coalesce(array(
    select x from jsonb_array_elements_text(case when jsonb_typeof(o -> key) = 'array' then o -> key else '[]'::jsonb end) x
  ), '{}')
$$;

-- contracts ApiError -> stored error (details kept as JSON, retryable defaults false).
create function public._stored_error(e jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
begin
  if e is null or jsonb_typeof(e) <> 'object' then return null; end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'code', public._req_text(e, 'code', 'error'),
    'message', public._req_text(e, 'message', 'error'),
    'details', e -> 'details',
    'retryable', coalesce((e ->> 'retryable')::boolean, false)));
end $$;

-- ---------------------------------------------------------------------------
-- menus
-- ---------------------------------------------------------------------------

-- Upsert the meal_service row and replace its menu_item rows. A higher version
-- first archives the outgoing items into menu_item_revision.
create function public.upsert_menu(p_menu jsonb) returns void
language plpgsql set search_path = public as $$
declare
  s jsonb := p_menu -> 'service';
  v_service_id text; v_menu_id text; v_version integer;
  existing public.meal_service;
  item jsonb;
begin
  if s is null or jsonb_typeof(s) <> 'object' then raise exception 'menu.service is required'; end if;
  if jsonb_typeof(p_menu -> 'items') is distinct from 'array' then raise exception 'menu.items must be an array'; end if;
  v_service_id := _req_text(s, 'serviceId', 'service');
  v_menu_id := _req_text(s, 'menuId', 'service');
  v_version := _req_num(s, 'menuVersion', 'service', 1)::integer;

  select * into existing from public.meal_service where service_id = v_service_id for update;
  if found then
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
  for item in select * from jsonb_array_elements(p_menu -> 'items') loop
    if _req_text(item, 'menuId', 'item') <> v_menu_id then
      raise exception 'item % belongs to menu %', item ->> 'itemId', item ->> 'menuId';
    end if;
    -- dish_id is preserved across re-uploads of the same item id.
    insert into public.menu_item (item_id, menu_id, display_name, category, description)
    values (_req_text(item, 'itemId', 'item'), v_menu_id, _req_text(item, 'displayName', 'item'),
            _opt_text(item, 'category'), _opt_text(item, 'description'));
  end loop;
end $$;

-- Validate all rows, then replace this service+version's portions snapshot.
create function public.replace_portions_served(p_snapshot jsonb) returns void
language plpgsql set search_path = public as $$
declare
  v_service_id text := _req_text(p_snapshot, 'serviceId', 'portions');
  v_version integer := _req_num(p_snapshot, 'menuVersion', 'portions', 1)::integer;
  svc public.meal_service;
  p jsonb; v_item text; v_count double precision; v_source text;
  seen text[] := '{}';
begin
  select * into svc from public.meal_service where service_id = v_service_id for update;
  if not found or svc.menu_version <> v_version then raise exception 'The menu changed; reload before saving portions.'; end if;
  if jsonb_typeof(p_snapshot -> 'portions') is distinct from 'array' then raise exception 'portions must be an array'; end if;

  for p in select * from jsonb_array_elements(p_snapshot -> 'portions') loop
    v_item := _req_text(p, 'itemId', 'portion');
    v_count := _req_num(p, 'count', 'portion');
    if v_item = any(seen) or not exists (select 1 from public.menu_item where menu_id = svc.menu_id and item_id = v_item) then
      raise exception 'Unknown or duplicate portions item';
    end if;
    seen := seen || v_item;
    if v_count <> trunc(v_count) or v_count > 2147483647 then
      raise exception 'Portions served must be a nonnegative whole number';
    end if;
    v_source := _req_text(p, 'source', 'portion');
    if v_source not in ('manual', 'csv', 'demo') then raise exception 'Invalid portions source'; end if;
    if p ->> 'serviceId' is distinct from v_service_id or (p ->> 'menuVersion')::integer is distinct from v_version
       or p ->> 'hallId' is distinct from svc.hall_id or p ->> 'serviceDate' is distinct from svc.service_date::text
       or p ->> 'menuId' is distinct from svc.menu_id then
      raise exception 'Portions service context differs';
    end if;
  end loop;

  delete from public.portions_served where service_id = v_service_id and menu_version = v_version;
  insert into public.portions_served
    (record_id, service_id, hall_id, service_date, menu_id, menu_version, item_id, count, source, updated_at)
  select jsonb_build_array(v_service_id, v_version, e.row ->> 'itemId')::text, v_service_id, svc.hall_id, svc.service_date,
         svc.menu_id, v_version, e.row ->> 'itemId', (e.row ->> 'count')::integer, e.row ->> 'source',
         (e.row ->> 'updatedAt')::timestamptz
  from jsonb_array_elements(p_snapshot -> 'portions') e(row);
end $$;

-- ---------------------------------------------------------------------------
-- admin curation
-- ---------------------------------------------------------------------------

-- Hide or show many captures at once; unknown event ids are rejected.
create function public.set_capture_visibility(p_event_ids text[], p_hidden boolean, p_updated_at timestamptz) returns void
language plpgsql set search_path = public as $$
declare v_missing text;
begin
  if p_event_ids is null or exists (select 1 from unnest(p_event_ids) id where id is null or id = '') then
    raise exception 'eventIdsJson must be a JSON array of non-empty strings';
  end if;
  select id into v_missing from unnest(p_event_ids) id
  where not exists (select 1 from public.capture_event where event_id = id) limit 1;
  if v_missing is not null then raise exception 'capture event % does not exist', v_missing; end if;
  insert into public.capture_visibility (event_id, hidden, updated_at)
  select distinct id, p_hidden, p_updated_at from unnest(p_event_ids) id
  on conflict (event_id) do update set hidden = excluded.hidden, updated_at = excluded.updated_at;
end $$;

-- ---------------------------------------------------------------------------
-- analysis attempts + measurements + segmentation + overlay
-- ---------------------------------------------------------------------------

-- Append one attempt with everything it produced, in one transaction, with the
-- same invariants as the record_analysis reducer.
create function public.record_analysis(p_attempt jsonb, p_measurements jsonb) returns void
language plpgsql set search_path = public as $$
declare
  a jsonb := p_attempt;
  v_attempt_id text := _req_text(p_attempt, 'attemptId', 'attempt');
  v_event_id text := _req_text(p_attempt, 'eventId', 'attempt');
  v_calibration_id text := _opt_text(p_attempt, 'calibrationId');
  v_physical_method text;
  m jsonb; flags text[]; v_raw double precision; v_area double precision; v_method text;
  v_measured double precision := 0;
  seg jsonb; r jsonb; box jsonb;
  v_width double precision; v_height double precision; v_capture double precision; v_count_status text; v_status text;
  v_mask_pixels double precision; v_region_status text;
  cal jsonb; v_overlay text; v_cal_method text; v_cal_flags text[]; v_expected double precision; v_dish text;
  overlay public.image_object;
begin
  if exists (select 1 from public.analysis_attempt where attempt_id = v_attempt_id) then
    raise exception 'attempt % already recorded', v_attempt_id;
  end if;
  if p_measurements is null or jsonb_typeof(p_measurements) <> 'array' then raise exception 'measurements must be an array'; end if;

  if a ? 'physicalMethod' and jsonb_typeof(a -> 'physicalMethod') <> 'null' then
    if a ->> 'physicalMethod' not in ('area-calibrated-v1', 'volume-dav2-v1') then
      raise exception 'attempt.physicalMethod ''%'' is not allowed', a ->> 'physicalMethod';
    end if;
    v_physical_method := 'area-calibrated-v1';
  end if;

  insert into public.analysis_attempt
    (attempt_id, event_id, menu_id, menu_version, baseline_versions, model, prompt_version, status, error,
     quality_flags, created_at, calibration_id, physical_method, depth_object_id)
  values (v_attempt_id, v_event_id, _req_text(a, 'menuId', 'attempt'), _req_num(a, 'menuVersion', 'attempt')::integer,
          coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(a -> 'baselineVersions', '{}')) e(k, v)
                    where jsonb_typeof(v) = 'number'), '{}'),
          _req_text(a, 'model', 'attempt'), _req_text(a, 'promptVersion', 'attempt'), _req_text(a, 'status', 'attempt'),
          _stored_error(a -> 'error'), _text_array(a, 'qualityFlags'), _req_text(a, 'createdAt', 'attempt')::timestamptz,
          v_calibration_id, v_physical_method, null);

  for m in select * from jsonb_array_elements(p_measurements) loop
    flags := _text_array(m, 'qualityFlags');
    v_raw := _opt_num(m, 'rawWasteFraction');
    v_method := _req_text(m, 'method', 'measurement');
    v_area := _req_num(m, 'remainingAreaPx', 'measurement');
    if v_raw is not null and v_raw > 1 and not ('above_baseline' = any(flags)) then
      raise exception 'measurement %: fraction > 1 must carry ''above_baseline''', m ->> 'measurementId';
    end if;
    if v_method <> 'mask_pixel_count' and _opt_num(m, 'displayWastePercent') is null and _opt_text(m, 'unavailableReason') is null then
      raise exception 'measurement %: unavailableReason required when no percentage', m ->> 'measurementId';
    end if;
    if _req_text(m, 'attemptId', 'measurement') <> v_attempt_id then
      raise exception 'measurement % is for another attempt', m ->> 'measurementId';
    end if;
    if v_method = 'mask_pixel_count' and v_area <> trunc(v_area) then
      raise exception 'measurement %: mask pixel counts are integers', m ->> 'measurementId';
    end if;
    if m -> 'physical' is not null and jsonb_typeof(m -> 'physical') = 'object'
       and (m -> 'physical' ->> 'calibrationId') is distinct from v_calibration_id then
      raise exception 'measurement %: physical.calibrationId differs from the attempt''s calibration', m ->> 'measurementId';
    end if;
    v_measured := v_measured + v_area;

    insert into public.food_measurement
      (measurement_id, event_id, attempt_id, item_id, remaining_area_px, baseline_id, baseline_area_px,
       raw_waste_fraction, display_waste_percent, unavailable_reason, method, mask_count, quality_flags, physical)
    values (_req_text(m, 'measurementId', 'measurement'), _req_text(m, 'eventId', 'measurement'), v_attempt_id,
            _opt_text(m, 'itemId'), v_area, _opt_text(m, 'baselineId'), _opt_num(m, 'baselineAreaPx'), v_raw,
            _opt_num(m, 'displayWastePercent'), _opt_text(m, 'unavailableReason'), v_method,
            case when v_method = 'mask_pixel_count' and jsonb_typeof(m -> 'maskCount') = 'object' then jsonb_build_object(
              'pixelsWasted', _req_num(m -> 'maskCount', 'pixelsWasted', 'mask'),
              'maskObjectId', _req_text(m -> 'maskCount', 'maskObjectId', 'mask'),
              'geometry', m -> 'maskCount' -> 'geometry',
              'menuId', _req_text(m -> 'maskCount', 'menuId', 'mask'),
              'menuVersion', _req_num(m -> 'maskCount', 'menuVersion', 'mask'),
              'classificationVersion', _req_text(m -> 'maskCount', 'classificationVersion', 'mask'),
              'segmentationVersion', _req_text(m -> 'maskCount', 'segmentationVersion', 'mask'),
              'processingVersion', _req_text(m -> 'maskCount', 'processingVersion', 'mask'),
              'assignment', m -> 'maskCount' -> 'assignment',
              'validated', coalesce((m -> 'maskCount' ->> 'validated')::boolean, false)) end,
            flags,
            case when jsonb_typeof(m -> 'physical') = 'object' then jsonb_build_object(
              'calibrationId', _req_text(m -> 'physical', 'calibrationId', 'physical'),
              'method', 'area-calibrated-v1',
              'areaCm2', _req_num(m -> 'physical', 'areaCm2', 'physical'),
              'flags', '[]'::jsonb) end);
  end loop;

  -- Segmentation stage (capture_count + regions).
  seg := a -> 'segmentation';
  if seg is not null and jsonb_typeof(seg) <> 'null' then
    if jsonb_typeof(seg) <> 'object' then raise exception 'attempt.segmentation must be an object'; end if;
    v_width := _req_num(seg, 'widthPx', 'segmentation', 0, true);
    v_height := _req_num(seg, 'heightPx', 'segmentation', 0, true);
    v_status := _req_text(seg, 'status', 'segmentation');
    v_count_status := _req_text(seg, 'countStatus', 'segmentation');
    if v_status not in ('succeeded', 'partial', 'failed', 'skipped') then
      raise exception 'segmentation.status ''%'' is not allowed', v_status;
    end if;
    if v_count_status not in ('complete', 'empty', 'partial', 'unavailable') then
      raise exception 'segmentation.countStatus ''%'' is not allowed', v_count_status;
    end if;
    v_capture := _opt_num(seg, 'capturePixelsWasted');
    if v_capture is not null and (v_capture <> trunc(v_capture) or v_capture < 0 or v_capture > v_width * v_height) then
      raise exception 'segmentation.capturePixelsWasted must be an integer within the image';
    end if;
    if v_count_status = 'unavailable' and v_capture is not null then raise exception 'an unavailable count has no pixel total'; end if;
    if v_count_status <> 'unavailable' and v_capture is null then raise exception 'a % count needs capturePixelsWasted', v_count_status; end if;
    if v_count_status = 'empty' and v_capture <> 0 then raise exception 'an empty plate counts 0 pixels'; end if;
    if v_count_status in ('complete', 'partial') and v_capture <> v_measured then
      raise exception 'capture union % != sum of measured pixels %', v_capture, v_measured;
    end if;

    insert into public.capture_count
      (attempt_id, event_id, model, checkpoint, code_revision, prompt_source, settings_version, counting_rule_version,
       status, count_status, capture_pixels_wasted, width_px, height_px)
    values (v_attempt_id, v_event_id, _req_text(seg, 'model', 'segmentation'), _req_text(seg, 'checkpoint', 'segmentation'),
            _req_text(seg, 'codeRevision', 'segmentation'), _req_text(seg, 'promptSource', 'segmentation'),
            _req_text(seg, 'settingsVersion', 'segmentation'), _req_text(seg, 'countingRuleVersion', 'segmentation'),
            v_status, v_count_status, v_capture::integer, v_width::integer, v_height::integer);

    for r in select * from jsonb_array_elements(case when jsonb_typeof(seg -> 'regions') = 'array' then seg -> 'regions' else '[]' end) loop
      v_region_status := _req_text(r, 'segmentationStatus', 'region');
      if v_region_status not in ('succeeded', 'failed', 'skipped') then
        raise exception 'region status ''%'' is not allowed', v_region_status;
      end if;
      v_mask_pixels := _opt_num(r, 'maskPixels');
      if v_mask_pixels is not null and (v_mask_pixels <> trunc(v_mask_pixels) or v_mask_pixels < 0 or v_mask_pixels > v_width * v_height) then
        raise exception 'region.maskPixels must be an integer within the image';
      end if;
      if r ->> 'attemptId' is distinct from v_attempt_id then raise exception 'region % is for another attempt', r ->> 'regionId'; end if;
      box := case when jsonb_typeof(r -> 'box') = 'object' then r -> 'box' else '{}' end;
      if jsonb_typeof(box -> 'gemini') is distinct from 'array' or jsonb_array_length(box -> 'gemini') <> 4 then
        raise exception 'region.box.gemini must be 4 finite numbers';
      end if;
      if jsonb_typeof(box -> 'pixelXyxy') is distinct from 'array' or jsonb_array_length(box -> 'pixelXyxy') <> 4 then
        raise exception 'region.box.pixelXyxy must be 4 finite numbers';
      end if;
      insert into public.segmentation_region
        (region_id, attempt_id, event_id, item_id, visual_label, gemini_box, pixel_box, box_convention,
         segmentation_status, mask_object_id, mask_pixels, score, error)
      values (_req_text(r, 'regionId', 'region'), v_attempt_id, v_event_id, _opt_text(r, 'itemId'),
              _req_text(r, 'visualLabel', 'region'),
              array(select x::double precision from jsonb_array_elements_text(box -> 'gemini') x),
              array(select x::double precision from jsonb_array_elements_text(box -> 'pixelXyxy') x),
              _req_text(box, 'convention', 'region.box'), v_region_status, _opt_text(r, 'maskObjectId'),
              v_mask_pixels::integer, _opt_num(r, 'score'), _stored_error(r -> 'error'));
    end loop;
  end if;

  -- Plate calibration (deprecated) and the overlay reference.
  cal := a -> 'calibration';
  v_overlay := _opt_text(a, 'overlayObjectId');
  if (cal is not null and jsonb_typeof(cal) <> 'null') or v_overlay is not null then
    if cal is not null and jsonb_typeof(cal) <> 'null' then
      if jsonb_typeof(cal) <> 'object' then raise exception 'attempt.calibration must be an object'; end if;
      v_cal_method := _req_text(cal, 'method', 'calibration');
      if v_cal_method not in ('plate-fit-v1', 'configured-default') then
        raise exception 'calibration.method ''%'' is not allowed', v_cal_method;
      end if;
      v_expected := power(_req_num(cal, 'plateDiameterCm', 'calibration', 0, true)
                          / _req_num(cal, 'plateDiameterPx', 'calibration', 0, true), 2);
      if abs(_req_num(cal, 'cm2PerPx', 'calibration', 0, true) - v_expected) > v_expected * 1e-3 then
        raise exception 'calibration.cm2PerPx % != (plateDiameterCm / plateDiameterPx)^2', cal ->> 'cm2PerPx';
      end if;
      if jsonb_typeof(cal -> 'flags') is distinct from 'array' then raise exception 'calibration.flags must be an array'; end if;
      v_cal_flags := _text_array(cal, 'flags');
      if exists (select 1 from unnest(v_cal_flags) f where f not in ('calibration_default', 'plate_cut_off', 'bowl_size_assumed')) then
        raise exception 'calibration flag is not allowed';
      end if;
      if v_cal_method = 'configured-default' and not ('calibration_default' = any(v_cal_flags)) then
        raise exception 'a configured-default calibration must carry ''calibration_default''';
      end if;
      v_dish := _opt_text(cal, 'dishType');
      if v_dish is not null and v_dish not in ('plate', 'bowl', 'other') then
        raise exception 'calibration.dishType ''%'' is not allowed', v_dish;
      end if;
    end if;
    if v_overlay is not null then
      select * into overlay from public.image_object where object_id = v_overlay;
      if not found or overlay.association_kind <> 'overlay' or overlay.association_id <> v_event_id then
        raise exception 'overlay % is not a registered overlay of capture %', v_overlay, v_event_id;
      end if;
    end if;
    insert into public.attempt_calibration (attempt_id, event_id, calibration, overlay_object_id)
    values (v_attempt_id, v_event_id,
            case when jsonb_typeof(cal) = 'object' then jsonb_strip_nulls(jsonb_build_object(
              'method', v_cal_method, 'plateDiameterCm', cal -> 'plateDiameterCm', 'plateDiameterPx', cal -> 'plateDiameterPx',
              'cm2PerPx', cal -> 'cm2PerPx', 'dishType', v_dish,
              'fullyVisible', case when jsonb_typeof(cal -> 'fullyVisible') = 'boolean' then cal -> 'fullyVisible' end,
              'flags', to_jsonb(v_cal_flags))) end,
            v_overlay);
  end if;

  -- The attempt's calibration snapshot must be a succeeded camera calibration.
  if v_calibration_id is not null and not exists (
       select 1 from public.camera_calibration where calibration_id = v_calibration_id and status = 'succeeded') then
    raise exception 'calibration % is not a succeeded camera calibration', v_calibration_id;
  end if;
  if v_physical_method is not null and v_calibration_id is null then
    raise exception 'attempt.physicalMethod needs attempt.calibrationId';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- camera calibration + measurement settings
-- ---------------------------------------------------------------------------

create function public._check_image_of(p_object_id text, p_kinds text[], p_association_id text, what text) returns void
language plpgsql stable set search_path = public as $$
begin
  if p_object_id is null then return; end if;
  if not exists (select 1 from public.image_object
                 where object_id = p_object_id and association_kind = any(p_kinds) and association_id = p_association_id) then
    raise exception '% % is not a registered % image of %', what, p_object_id, array_to_string(p_kinds, '/'), p_association_id;
  end if;
end $$;

-- A succeeded calibration has referencePixels > 0 and cm2PerPx = knownAreaCm2 / referencePixels.
-- Once succeeded or failed, a calibration cannot change.
create function public.upsert_camera_calibration(p_calibration jsonb) returns void
language plpgsql set search_path = public as $$
declare
  c jsonb := p_calibration;
  i jsonb := p_calibration -> 'intrinsics';
  v_id text := _req_text(p_calibration, 'calibrationId', 'calibration');
  v_status text := _req_text(p_calibration, 'status', 'calibration');
  v_width double precision; v_height double precision; v_known double precision; v_ref double precision; v_k double precision;
  v_flags text[]; v_existing text;
begin
  if v_status not in ('processing', 'succeeded', 'failed') then raise exception 'calibration.status ''%'' is not allowed', v_status; end if;
  if _req_text(c, 'method', 'calibration') <> 'reference-area-v1' then raise exception 'calibration.method must be ''reference-area-v1'''; end if;
  v_width := _req_num(c, 'widthPx', 'calibration', 0, true);
  v_height := _req_num(c, 'heightPx', 'calibration', 0, true);
  v_known := _req_num(c, 'knownAreaCm2', 'calibration', 0, true);
  v_ref := _req_num(c, 'referencePixels', 'calibration');
  v_k := _req_num(c, 'cm2PerPx', 'calibration');
  if v_ref <> trunc(v_ref) or v_ref > v_width * v_height then
    raise exception 'calibration.referencePixels must be an integer within the image';
  end if;
  if v_status = 'succeeded' then
    if v_ref <= 0 then raise exception 'a succeeded calibration needs referencePixels > 0'; end if;
    if abs(v_k - v_known / v_ref) > (v_known / v_ref) * 1e-6 then
      raise exception 'calibration.cm2PerPx must equal knownAreaCm2 / referencePixels';
    end if;
  end if;
  if i is null or jsonb_typeof(i) <> 'object' then raise exception 'calibration.intrinsics is required'; end if;
  if _req_text(i, 'source', 'intrinsics') not in ('nominal-fov', 'checkerboard', 'configured') then
    raise exception 'intrinsics.source ''%'' is not allowed', i ->> 'source';
  end if;
  -- Legacy depth flags a pre-removal client may still send are dropped.
  v_flags := array(select f from unnest(_text_array(c, 'flags')) f where f not in ('depth_unavailable', 'depth_scale_disagrees'));
  if exists (select 1 from unnest(v_flags) f where f not in ('reference_not_found', 'reference_low_confidence', 'reference_touches_edge')) then
    raise exception 'calibration flag is not allowed';
  end if;

  perform _check_image_of(_req_text(c, 'imageObjectId', 'calibration'), array['calibration'], v_id, 'calibration.imageObjectId');
  perform _check_image_of(_opt_text(c, 'overlayObjectId'), array['calibration_overlay'], v_id, 'calibration.overlayObjectId');
  perform _check_image_of(_opt_text(c, 'referenceMaskObjectId'), array['calibration_overlay', 'mask'], v_id, 'calibration.referenceMaskObjectId');

  select status into v_existing from public.camera_calibration where calibration_id = v_id for update;
  if found and v_existing <> 'processing' then
    raise exception 'calibration % is % and cannot change', v_id, v_existing;
  end if;

  insert into public.camera_calibration
    (calibration_id, hall_id, camera_id, created_at, status, method, image_object_id, overlay_object_id,
     reference_mask_object_id, width_px, height_px, known_area_cm2, reference_label, reference_pixels, cm2_per_px,
     intrinsics, camera_height_cm_geometric, depth, flags, error)
  values (v_id, _req_text(c, 'hallId', 'calibration'), _req_text(c, 'cameraId', 'calibration'),
          _req_text(c, 'createdAt', 'calibration')::timestamptz, v_status, 'reference-area-v1',
          c ->> 'imageObjectId', _opt_text(c, 'overlayObjectId'), _opt_text(c, 'referenceMaskObjectId'),
          v_width::integer, v_height::integer, v_known, _req_text(c, 'referenceLabel', 'calibration'), v_ref::integer, v_k,
          jsonb_build_object(
            'cameraModel', _req_text(i, 'cameraModel', 'intrinsics'),
            'widthPx', _req_num(i, 'widthPx', 'intrinsics', 0, true), 'heightPx', _req_num(i, 'heightPx', 'intrinsics', 0, true),
            'fxPx', _req_num(i, 'fxPx', 'intrinsics', 0, true), 'fyPx', _req_num(i, 'fyPx', 'intrinsics', 0, true),
            'cxPx', _req_num(i, 'cxPx', 'intrinsics'), 'cyPx', _req_num(i, 'cyPx', 'intrinsics'), 'source', i ->> 'source'),
          _req_num(c, 'cameraHeightCmGeometric', 'calibration'), null, v_flags, _stored_error(c -> 'error'))
  on conflict (calibration_id) do update set
    hall_id = excluded.hall_id, camera_id = excluded.camera_id, created_at = excluded.created_at, status = excluded.status,
    image_object_id = excluded.image_object_id, overlay_object_id = excluded.overlay_object_id,
    reference_mask_object_id = excluded.reference_mask_object_id, width_px = excluded.width_px, height_px = excluded.height_px,
    known_area_cm2 = excluded.known_area_cm2, reference_label = excluded.reference_label,
    reference_pixels = excluded.reference_pixels, cm2_per_px = excluded.cm2_per_px, intrinsics = excluded.intrinsics,
    camera_height_cm_geometric = excluded.camera_height_cm_geometric, depth = null, flags = excluded.flags, error = excluded.error;
end $$;

-- The active calibration must be a succeeded calibration of this hall.
create function public.upsert_measurement_settings(p_settings jsonb) returns void
language plpgsql set search_path = public as $$
declare
  v_hall text := _req_text(p_settings, 'hallId', 'settings');
  v_active text := _opt_text(p_settings, 'activeCalibrationId');
begin
  if v_active is not null and not exists (
       select 1 from public.camera_calibration where calibration_id = v_active and hall_id = v_hall and status = 'succeeded') then
    raise exception 'calibration % is not a succeeded calibration of hall %', v_active, v_hall;
  end if;
  insert into public.measurement_settings (hall_id, depth_enabled, active_calibration_id, plate_thickness_cm, updated_at)
  values (v_hall, false, v_active, 0, _req_text(p_settings, 'updatedAt', 'settings')::timestamptz)
  on conflict (hall_id) do update set active_calibration_id = excluded.active_calibration_id, updated_at = excluded.updated_at;
end $$;

-- ---------------------------------------------------------------------------
-- sample data
-- ---------------------------------------------------------------------------

-- Remove every row the demo seed created (and only those), children first so
-- foreign keys hold. Returns how many markers there were.
create function public.clear_demo_data() returns integer
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
  delete from public.demo_marker;
  return v_count;
end $$;
