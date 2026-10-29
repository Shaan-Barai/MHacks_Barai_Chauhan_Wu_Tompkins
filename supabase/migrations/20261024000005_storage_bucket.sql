-- Private Storage bucket for tray photos, originals, segmentation masks and
-- overlays, calibration photos and (later) production sheet photos.
-- Object paths keep the existing naming, e.g. captures/2026-10-24/<eventId>.jpg,
-- masks/<date>/<regionId>.png, overlays/<date>/<eventId>_<attemptId>.jpg.
--
-- No storage.objects policies are created, so the anon key and signed-in users
-- cannot list, read or write objects directly. The backend (service role)
-- uploads and issues short-lived signed upload/read URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scrap-images', 'scrap-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
