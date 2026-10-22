-- The live jobs exist only while racing is on.
-- kyw-hk-odds (every minute) is scheduled only for the UTC hours of an active Hong Kong meeting's tote window,
-- 35 minutes before its first race to 3 minutes after its last; kyw-sync (every 10 minutes) only for the hours
-- from 45 minutes before the day's first race to 20 minutes after its last. With no meeting in the window the job
-- is removed, so a day without Hong Kong racing runs no Hong Kong job at all. Each job keeps its own minute-level
-- check, so the minutes of an armed hour outside the window still do nothing.
-- The trigger re-arms whenever kyw_feed changes: the morning roll (first_at and last_at cleared), and the first
-- sync after it (race times filled in).

create or replace function public.kyw_set_job(job text, sched text, cmd text) returns void
language plpgsql security definer set search_path = public, cron as $$
declare cur record;
begin
  select jobid, schedule, command into cur from cron.job where jobname = job;
  if sched is null then
    if found then perform cron.unschedule(cur.jobid); end if;
  elsif not found then
    perform cron.schedule(job, sched, cmd);
  elsif cur.schedule is distinct from sched or cur.command is distinct from cmd then
    perform cron.alter_job(cur.jobid, schedule := sched, command := cmd);
  end if;
end $$;

create or replace function public.kyw_arm_jobs() returns void
language plpgsql security definer set search_path = public, cron as $$
declare hk text; au text;
begin
  select string_agg(h::text, ',' order by h) into hk from (
    select distinct extract(hour from g)::int h from kyw_feed f,
      generate_series(date_trunc('hour', f.first_at - interval '35 minutes'), f.last_at + interval '3 minutes', interval '1 hour') g
    where f.active and f.meet_id like 'HK%' and f.first_at is not null and f.last_at is not null) x;
  select string_agg(h::text, ',' order by h) into au from (
    select distinct extract(hour from g)::int h from kyw_feed f,
      generate_series(date_trunc('hour', f.first_at - interval '45 minutes'), f.last_at + interval '20 minutes', interval '1 hour') g
    where f.active and f.first_at is not null and f.last_at is not null) x;
  perform kyw_set_job('kyw-hk-odds', case when hk is null then null else '* ' || hk || ' * * *' end, $c$
  select net.http_post('https://qgomklldlpspwilyjdqx.supabase.co/functions/v1/kyw-sync?hkodds=1', '{}'::jsonb, '{}'::jsonb, '{"Content-Type":"application/json","x-flock-code":"pelicans-2026"}'::jsonb, 50000)
  where exists (select 1 from kyw_feed where active and meet_id like 'HK%' and first_at is not null and now() between first_at - interval '35 minutes' and last_at + interval '3 minutes');
$c$);
  perform kyw_set_job('kyw-sync', case when au is null then null else '*/10 ' || au || ' * * *' end, $c$
  select net.http_post('https://qgomklldlpspwilyjdqx.supabase.co/functions/v1/kyw-sync', '{}'::jsonb, '{}'::jsonb, '{"Content-Type":"application/json","x-flock-code":"pelicans-2026"}'::jsonb, 55000)
  where exists (select 1 from kyw_feed where active and first_at is not null and now() between first_at - interval '45 minutes' and last_at + interval '20 minutes');
$c$);
end $$;

create or replace function public.kyw_feed_arm() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform kyw_arm_jobs(); return null; end $$;

drop trigger if exists kyw_feed_arm on public.kyw_feed;
create trigger kyw_feed_arm after insert or update or delete on public.kyw_feed
  for each statement execute function public.kyw_feed_arm();

revoke all on function public.kyw_set_job(text, text, text), public.kyw_arm_jobs(), public.kyw_feed_arm() from public, anon, authenticated;

-- Job history is kept two days, trimmed daily (it was seven days, trimmed weekly).
select public.kyw_set_job('kyw-housekeeping', '30 20 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '2 days'; delete from kyw_feed_log where at < now() - interval '7 days';$c$);

select public.kyw_arm_jobs();
