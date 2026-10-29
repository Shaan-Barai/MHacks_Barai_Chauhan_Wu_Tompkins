-- production_log becomes private (Run 3, Phase 1): reviewer names ("confirmed by")
-- and sheet photo paths are no longer readable with the publishable key. The
-- backend already serves these rows with the service role. No data changes;
-- only the anon/authenticated read grant and its policy go.

drop policy if exists "dashboard read" on public.production_log;
revoke select on public.production_log from anon, authenticated;
