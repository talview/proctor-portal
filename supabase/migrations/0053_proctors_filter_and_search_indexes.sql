-- From the external review's two genuinely valid findings (checked against the actual
-- code/schema first -- see conversation): ProctorsPage/OffboardedPage/IncompletePage/
-- InterviewSelectsPage all filter proctors by `managed_by` (not `vendor`, which is what
-- idx_proctors_vendor actually indexes) and by `ptype`, and none of those had a
-- matching index; the docsStatus='expired' filter compares nda_link_expires_at but only
-- ever alongside final_form_status='sent', with no supporting index either.
create index idx_proctors_managed_by on proctors (managed_by);
create index idx_proctors_ptype on proctors (ptype);
create index idx_proctors_nda_link_expires_at
  on proctors (nda_link_expires_at)
  where final_form_status = 'sent';

-- Search across these pages runs `.or('name.ilike.%x%,email.ilike.%x%,...')` -- a
-- leading wildcard defeats a plain B-tree index outright, regardless of table size.
-- pg_trgm's GIN indexes are what actually accelerate ILIKE '%substring%' as-written,
-- unlike full-text search (to_tsvector), which matches whole words/stems and wouldn't
-- help substring search over names/emails/phone numbers/ids the way this app uses it.
create extension if not exists pg_trgm;

create index idx_proctors_name_trgm on proctors using gin (name gin_trgm_ops);
create index idx_proctors_email_trgm on proctors using gin (email gin_trgm_ops);
create index idx_proctors_phone_trgm on proctors using gin (phone gin_trgm_ops);
create index idx_proctors_pid_trgm on proctors using gin (pid gin_trgm_ops);
