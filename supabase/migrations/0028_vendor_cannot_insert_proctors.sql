-- Vendors could previously insert their own proctor rows directly (Add/Bulk Onboard
-- on /add-proctor, and Add/Import CSV on Interview Selects) -- per explicit feedback,
-- vendors should only ever view the interview selects/proctors admin has already
-- imported under them, never add new ones themselves. The frontend now hides those
-- entry points for vendor entirely (AddProctorPage is blocked outright;
-- InterviewSelectsPage's Add/Import/Send Form are gated behind the same read-only
-- check as coordinator), but that's UI-only -- this closes the matching RLS gap so a
-- vendor can't insert via a direct API call either.

DROP POLICY IF EXISTS proctors_insert ON proctors;

CREATE POLICY proctors_insert ON proctors FOR INSERT TO authenticated
  WITH CHECK (current_user_role() IN ('admin', 'coordinator'));
