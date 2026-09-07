-- Temporary revert of migration 0045. That migration correctly found zero Realtime
-- usage in THIS repo (sadiq-ss/proctor-portal-react), but missed that the actually
-- deployed production app is built from a second, independently-evolved repo
-- (shivamtalview/proctor-portal-react) whose src/hooks/useRealtimeSync.ts *does*
-- subscribe to postgres_changes on exactly these 10 tables, wired in via MainLayout.tsx,
-- to live-refresh the UI when another user changes data. Restoring publication
-- membership here so production keeps that live-refresh behavior until the app-code
-- sync (bringing shivamtalview's repo to match this one, which has no Realtime usage)
-- actually ships -- at which point this can be safely re-dropped for good.
alter publication supabase_realtime add table
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
