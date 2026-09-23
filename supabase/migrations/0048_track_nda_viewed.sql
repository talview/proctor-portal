-- Surfaces a real "Viewed" status for the onboarding docs/NDA flow, previously logged
-- (nda_signing_events.event_type = 'nda_viewed', from nda-session-consent /
-- nda-session-submit) but never read back anywhere in the UI. A trigger, not an
-- application-level update, so it fires regardless of which function logs the event,
-- and future callers get it for free. Written once per proctor (first-viewed, via
-- COALESCE) rather than overwritten on every subsequent view -- "when did they first
-- open this" is the meaningful fact for the status badge.
--
-- The pre-onboarding form side of the same "Viewed" status needs no equivalent
-- column/trigger -- proctors.form_access_count (incremented in send-otp on every OTP
-- request for the form link) is already the exact same signal, already stored, no new
-- write path needed.
alter table proctors add column if not exists nda_viewed_at timestamptz;

create or replace function sync_nda_viewed_at()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if NEW.event_type = 'nda_viewed' then
    update proctors p
    set nda_viewed_at = coalesce(p.nda_viewed_at, NEW.occurred_at)
    from nda_signing_sessions s
    where s.id = NEW.session_id and p.id = s.proctor_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_nda_viewed_at on nda_signing_events;
create trigger trg_sync_nda_viewed_at
  after insert on nda_signing_events
  for each row execute function sync_nda_viewed_at();
