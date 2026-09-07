-- No code in this app (frontend or edge functions) ever subscribes to Supabase
-- Realtime (no supabase.channel()/postgres_changes usage anywhere -- verified by
-- grep across src/ and supabase/functions/). Yet these 10 tables were added to the
-- supabase_realtime publication, so Postgres continuously decodes and broadcasts
-- their WAL changes to the Realtime service for no consumer. On the project's
-- current (Micro) compute add-on this is a real, avoidable contributor to the
-- Disk IO budget alert -- pg_stat_statements showed Realtime's WAL-decode query
-- with 69k+ calls and 114M+ buffer touches since the last stats reset, dwarfing
-- every query this app's own code issues.
--
-- Purely a publication membership change: no rows are touched, no RLS/PostgREST/
-- RPC behavior changes, and it's trivially reversible with
-- `ALTER PUBLICATION supabase_realtime ADD TABLE <name>;` if a Realtime feature is
-- ever built against one of these tables later.
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
