-- Bug found during live testing: "Add Note" in the workspace failed with
-- 'null value in column "username" of relation "user_notes" violates not-null
-- constraint'. `username` is a legacy column from before migration 0003 added
-- `user_id` and re-keyed user_notes' RLS policy off it -- the frontend has
-- never written or read `username` since, only `user_id`, so it's dead weight
-- that still blocks every insert. Drop the NOT NULL rather than the column
-- itself, in case anything outside this repo still reads it.

ALTER TABLE user_notes ALTER COLUMN username DROP NOT NULL;
