-- Migration 0046 temporarily restored these 10 tables to the Realtime publication,
-- pending the app-code sync (talview/proctor-portal#5, merged 2026-09-07) actually
-- shipping to production -- at which point useRealtimeSync.ts (the only code that
-- ever subscribed to them) goes away for good and this becomes unconditionally safe
-- to drop again.
--
-- That deploy still hadn't gone live as of this migration, but the 2026-09-13 Disk IO
-- Budget incident changed the trade-off: this publication runs unconditional
-- background WAL-decode work 24/7 regardless of whether anyone is using the app --
-- it was one of the two concrete background drains (alongside the 1-minute
-- bulk-dispatch-worker cron) that kept consuming the Disk IO budget through an entire
-- week of zero app usage. A week of no live cross-tab refresh is an acceptable, known
-- trade-off; a repeat of a full production outage over an already-migrated-off
-- feature is not. Re-add the 10 tables once the new build is actually confirmed live,
-- if the feature is still wanted at that point.
alter publication supabase_realtime drop table
  public.proctors,
  public.audit_log,
  public.users,
  public.customers,
  public.proctor_certifications,
  public.proctor_evaluations,
  public.user_notes,
  public.vendors,
  public.final_onboarding_forms,
  public.vendor_contacts;
