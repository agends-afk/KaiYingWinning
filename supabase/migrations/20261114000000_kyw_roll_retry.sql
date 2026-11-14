-- The 6am AEST roll (kyw-sync-daily-full, 20:00 UTC) is a single HTTP call. If the gateway refuses it (a 503 on 14 Nov 2026),
-- the feed stays on yesterday's meetings all day. These two jobs re-run the roll at 6:20 and 6:45 AEST, only when no active
-- feed row is dated today (AEST, as kyw-sync's aestDate computes it), so a successful 6am roll is never repeated.
create or replace function public.kyw_roll_retry() returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from kyw_feed where active and date = ((now() at time zone 'UTC') + interval '10 hours')::date) then return; end if;
  perform net.http_post('https://qgomklldlpspwilyjdqx.supabase.co/functions/v1/kyw-sync?daily=1', '{}'::jsonb, '{}'::jsonb,
    '{"Content-Type":"application/json","x-flock-code":"pelicans-2026"}'::jsonb, 300000);
end $$;

select cron.schedule('kyw-roll-retry-1', '20 20 * * *', 'select public.kyw_roll_retry()');
select cron.schedule('kyw-roll-retry-2', '45 20 * * *', 'select public.kyw_roll_retry()');
