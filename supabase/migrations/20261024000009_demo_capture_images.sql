-- Sample-history captures (DEMO_SEED, backend/src/services/demoService.ts) have
-- no photo: their image_object_id is the sentinel 'demo:none'. The foreign key
-- from capture_event.image_object_id rejected them, so demo seeding failed on
-- Supabase. Real captures always register their image before the capture
-- (ingestion), so this column keeps an index but no foreign key.

alter table public.capture_event drop constraint capture_event_image_object_id_fkey;
create index capture_event_image_object_idx on public.capture_event (image_object_id);
