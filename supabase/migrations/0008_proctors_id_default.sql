-- Bug found during user testing: proctors.id has no default and is NOT NULL, but
-- AddProctorPage's individual and bulk onboarding inserts never set it client-side
-- (only the CSV interview-select import path does). Every such insert failed with
-- "null value in column id violates not-null constraint". Fixing at the column level
-- covers every current and future insert path in one place.

ALTER TABLE proctors ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
