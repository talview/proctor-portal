-- proctors.dob has been free text since day one -- 100 of 110 existing rows are in
-- M/D/YY format from historical CSV imports (e.g. "8/13/94"), not the ISO format the
-- app's own date pickers produce. Confirmed unambiguous across the whole dataset: many
-- rows have a value >12 in the second position only (e.g. "10/19/90", "12/30/90"),
-- which can only be a day, never a month -- proving month-first, day-second for this
-- entire batch. All 2-digit years fall in 90-99 (-> 1990s), consistent with plausible
-- present-day ages. Verified live (dry-run SELECT) before writing this migration.

-- One existing row already violates the 18+ rule this migration is about to enforce:
-- a test proctor ("SADIQ ALI", dob = the day this bug was found) created while
-- confirming the original age-validation gap -- not real data. Removed per explicit
-- confirmation; both FKs referencing proctors(id) already cascade
-- (nda_signing_sessions, bulk_dispatch_items), and this row had no evaluations or
-- certifications.
delete from proctors where id = '6d730629-4e0d-480c-9e23-0c93aa6d0a56';

-- Empty string can't cast to `date` -- NULL is the correct representation of "not on
-- file" for the 4 rows that have neither.
update proctors set dob = null where dob = '';

-- Normalize every M/D/YY row to ISO before the type change below requires every
-- remaining value to already be a valid date.
update proctors
set dob = (case when split_part(dob, '/', 3)::int <= 30 then '20' else '19' end)
  || split_part(dob, '/', 3) || '-'
  || lpad(split_part(dob, '/', 1), 2, '0') || '-'
  || lpad(split_part(dob, '/', 2), 2, '0')
where dob is not null and dob !~ '^\d{4}-\d{2}-\d{2}$';

-- Every value is now either NULL or a clean ISO date string -- safe to actually be a
-- `date` column, so no future insert (from any of the 3 write paths: individual add,
-- CSV bulk import, or the public onboarding form) can ever store an unparseable or
-- inconsistently-formatted value here again. The column's own default ('' as text)
-- can't auto-cast either -- dropped rather than replaced, since there's no sensible
-- default date and NULL (the implicit default with none set) is the correct
-- "not on file" representation anyway.
alter table proctors alter column dob drop default;
alter table proctors alter column dob type date using dob::date;

-- Matches the 18+ check already enforced in the app (OnboardingFormPage,
-- AddProctorPage, submit-onboarding-form) -- this is the backstop for any future
-- write path that might not go through those checks.
alter table proctors add constraint proctors_dob_min_age_18
  check (dob is null or dob <= (current_date - interval '18 years')::date);
