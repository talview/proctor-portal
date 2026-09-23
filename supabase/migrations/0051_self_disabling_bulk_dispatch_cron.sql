-- The 1-minute cron (drain-bulk-dispatch-queue) previously invoked bulk-dispatch-worker
-- unconditionally, every single minute, forever -- even during a full week of zero app
-- usage, as the 2026-09-13 Disk IO Budget incident demonstrated. The worker itself
-- already no-ops cheaply when nothing is queued, but "cheap" still means a real Edge
-- Function invocation + a database round trip, every minute, regardless of whether
-- there's any actual work.
--
-- ensure_bulk_dispatch_cron() (re)creates the cron job with a command that checks for
-- actual work FIRST, in plain SQL, before ever invoking the worker -- and unschedules
-- itself the moment nothing is left queued or processing anywhere. bulk-dispatch-create
-- and bulk-dispatch-retry call this function right after queuing new work, so the cron
-- job always exists whenever there's something for it to do, and doesn't exist (zero
-- cost, not just a cheap no-op) the rest of the time.
create or replace function ensure_bulk_dispatch_cron()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'drain-bulk-dispatch-queue';

  perform cron.schedule(
    'drain-bulk-dispatch-queue',
    '* * * * *',
    $cron$
    do $body$
    begin
      if exists (select 1 from bulk_dispatch_items where status in ('queued', 'processing')) then
        perform net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'bulk_dispatch_project_url') || '/functions/v1/bulk-dispatch-worker',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Bulk-Worker-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bulk_worker_secret')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 8000
        );
      else
        perform cron.unschedule(jobid) from cron.job where jobname = 'drain-bulk-dispatch-queue';
      end if;
    end;
    $body$;
    $cron$
  );
end;
$$;

revoke all on function ensure_bulk_dispatch_cron() from public;
grant execute on function ensure_bulk_dispatch_cron() to service_role;

-- Nothing is currently queued/processing (verified live before this migration), so
-- start disabled rather than re-arming into an immediate no-op state -- the next real
-- bulk-dispatch-create/retry call re-arms it.
select cron.unschedule(jobid) from cron.job where jobname = 'drain-bulk-dispatch-queue';
