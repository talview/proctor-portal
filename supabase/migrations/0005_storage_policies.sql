-- Storage buckets had the same "allow anon" pattern as the database tables: anyone with
-- the public anon key could upload arbitrary files to BGV/NDA background-check document
-- buckets (spam/abuse vector). Restrict uploads to authenticated users.
--
-- Reads are intentionally left open (anon + authenticated): the app renders these as plain
-- `<a href>` links generated via getPublicUrl(), which send no Authorization header, and
-- this bucket's original "anon SELECT" policy is what made those links work at all (the
-- bucket itself is not flagged public). Restricting reads properly needs a move to signed
-- URLs (generated fresh per view) plus storing paths instead of full URLs -- a follow-up,
-- not done here to avoid silently breaking every existing document link. Read access today
-- relies on the file path being an unguessable UUID, similar to the public onboarding form's
-- proctor-id-based flow.

DROP POLICY IF EXISTS "Allow anon read bgv" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon read nda" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon upload bgv" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon upload nda" ON storage.objects;

CREATE POLICY "Allow read bgv" ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'bgv-documents');
CREATE POLICY "Allow authenticated upload bgv" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'bgv-documents');

CREATE POLICY "Allow read nda" ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'nda-documents');
CREATE POLICY "Allow authenticated upload nda" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'nda-documents');
