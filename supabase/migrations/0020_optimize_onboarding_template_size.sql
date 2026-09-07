-- Live feedback: the generated/signed onboarding PDF is ~22MB, vs ~4.5MB from the
-- Dropbox Sign reference. Root cause investigated directly against the live template
-- bytes (supabase/functions/nda-session-submit only adds one small signature PNG and
-- some text per session -- it never re-renders the base document): the source
-- 333-page PDF itself is 21.4MB, of which `pdfimages -list` only accounts for ~8.3MB
-- of actual image data. The remaining ~13MB is duplicate objects -- a small
-- header/footer logo re-embedded as its own object on almost every page instead of
-- one shared XObject referenced everywhere, plus uncompressed cross-reference tables --
-- classic "print to PDF" bloat, not intentional image quality.
--
-- Fix: re-saved the template through PyMuPDF with garbage=4 (dedupe + compact objects),
-- deflate=True and clean=True. This is lossless -- verified by rendering every
-- field-bearing page (9, 27, 30, 329, 332) from both files at 100 DPI and comparing
-- pixel hashes: identical. Page count, page dimensions and all field_map coordinates
-- are therefore still valid against this file unchanged. Result: 21,467,548 bytes ->
-- 9,351,937 bytes (~56% smaller), no quality loss.
--
-- Field map copied verbatim from migration 0014 (only storage_path/content_sha256/
-- byte_size/version differ).

UPDATE nda_templates SET is_active = false, retired_at = now() WHERE is_active = true;

WITH prev AS (
  SELECT field_map, version
  FROM nda_templates
  WHERE storage_path = 'templates/onboarding-doc-v1.pdf'
  ORDER BY version DESC
  LIMIT 1
)
INSERT INTO nda_templates
    (version, label, storage_bucket, storage_path, content_sha256, byte_size,
     page_count, field_map, is_active, published_by)
SELECT
    prev.version + 1,
    'Onboarding Documents (AUP, Disciplinary Action, Code of Ethics, Code of Conduct, NDA)',
    'nda-signing',
    'templates/onboarding-doc-v2.pdf',
    '4acadb79a522f0596486663af45c6a211764ee0a5085db4885e773aa247e772e',
    9351937,
    333,
    prev.field_map,
    true,
    'sadiq.a@talview.com'
FROM prev;
