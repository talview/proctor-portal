-- bgv-documents has allowed anonymous reads since migration 0005, relying purely on an
-- unguessable UUID-based file path for protection -- a real risk given these are
-- background-verification reports, genuinely sensitive personal data. The nda-signing
-- bucket already solved this correctly (migration 0012): authenticated-only reads, the
-- app mints a short-lived signed URL per view instead of storing/using a public one.
-- Mirrored here. Verified live before this migration: zero proctor rows currently have
-- a bgv value on file, so there's nothing to migrate -- this is a clean cutover, not a
-- backward-compatibility problem.
DROP POLICY IF EXISTS "Allow read bgv" ON storage.objects;
CREATE POLICY "Allow authenticated read bgv" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'bgv-documents');
