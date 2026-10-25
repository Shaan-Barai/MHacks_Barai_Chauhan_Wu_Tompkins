/**
 * Integration: Supabase Realtime delivers scan changes to the anon
 * (publishable) key the dashboard uses, so open dashboards refresh without a
 * reload. Writes a throwaway hall-rt-* service, image and capture with the
 * service role key, and deletes them afterwards.
 * Skipped (with a message) when SUPABASE_URL / the keys are not in ../.env.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { REPO, supabaseAvailable } from '../support/stack.mjs';

const { createClient } = createRequire(`${REPO}backend/package.json`)('@supabase/supabase-js');
const skip = supabaseAvailable() && process.env.SUPABASE_ANON_KEY ? false : 'SUPABASE_URL (https://<ref>.supabase.co), SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are not set in .env';

const run = `rt${Date.now().toString(36)}`;
const hall = `hall-${run}`;
const serviceId = `svc_${hall}_2026-10-24_lunch`;

describe('Supabase Realtime: scan changes reach the publishable key', { skip }, () => {
  const admin = skip ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = skip ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  after(async () => {
    if (skip) return;
    await anon.removeAllChannels();
    await admin.from('capture_event').delete().eq('hall_id', hall);
    await admin.from('image_object').delete().eq('association_id', `cap_${run}`);
    await admin.from('meal_service').delete().eq('hall_id', hall);
    await admin.from('menu_item').delete().like('item_id', `%${run}%`);
    await admin.from('hall').delete().eq('hall_id', hall);
  });

  it('an inserted and then updated capture_event is broadcast to an anon subscriber', async () => {
    const menu = {
      service: { serviceId, hallId: hall, hallTimezone: 'America/Detroit', serviceDate: '2026-10-24', mealLabel: 'lunch', menuId: `menu_${run}`, menuVersion: 1 },
      items: [{ itemId: `item_${run}_rice`, menuId: `menu_${run}`, displayName: 'Rice' }],
    };
    assert.equal((await admin.rpc('upsert_menu', { p_menu: menu })).error, null);
    const image = {
      object_id: `img_${run}`, provider: 'supabase', container: 'scrap-images', object_key: `test/${run}/captures/x.jpg`,
      mime_type: 'image/jpeg', size_bytes: 10, association_kind: 'capture', association_id: `cap_${run}`, state: 'finalized',
    };
    assert.equal((await admin.from('image_object').insert(image)).error, null);

    const received = [];
    const subscribed = new Promise((resolve, reject) => {
      anon
        .channel(`test-${run}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'capture_event' }, (payload) => {
          if (payload.new?.hall_id === hall) received.push(payload.eventType);
        })
        .subscribe((status) => (status === 'SUBSCRIBED' ? resolve() : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? reject(new Error(status)) : null));
    });
    await subscribed;
    // Postgres-change subscriptions register a moment after SUBSCRIBED; a write in
    // that gap is not delivered. (Open dashboards subscribe once and stay subscribed.)
    await new Promise((r) => setTimeout(r, 3000));

    const event = {
      event_id: `cap_${run}`, hall_id: hall, service_id: serviceId, captured_at: new Date().toISOString(), image_object_id: image.object_id,
      width_px: 1024, height_px: 1024, coordinate_space: 'topdown-normalized-v1', source: 'replay', quality_flags: [], state: 'processing',
    };
    assert.equal((await admin.from('capture_event').insert(event)).error, null);
    assert.equal((await admin.from('capture_event').update({ state: 'succeeded' }).eq('event_id', event.event_id)).error, null);

    const deadline = Date.now() + 15_000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(received, ['INSERT', 'UPDATE'], 'the dashboard hears about the new scan and its finished analysis');
  });
});
