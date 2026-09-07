-- Publishes a further web-optimized/linearized re-export of the onboarding documents
-- PDF (21.4MB v1 -> 9.35MB v2 -> 2.9MB v3), and adds a configurable NDA link expiry
-- policy to nda_templates.
--
-- Verified before activating (not a blind swap): the new file's pages are all
-- uniformly 595.5x842pt, but four field-bearing pages -- page_index 16, 32, 329, 330 --
-- were 612x792pt (US Letter) in the v1/v2 field_map, unchanged from migration 0014.
-- fieldRectToPdfSpace() in supabase/functions/_shared/nda.ts hard-rejects any page-size
-- mismatch beyond 1pt, so activating this file with the old field_map as-is would break
-- signing on exactly those four pages -- including the main CIIA employee signature
-- page (329) and the Exhibit A employee-signature block (330).
--
-- Fix applied here: re-derived the field-map entries for just those 4 pages by
-- extracting exact label/underline positions from the new file with PyMuPDF
-- (get_text('words') + get_drawings()) and cross-checked visually by rendering the
-- computed boxes back onto the pages. The other 7 field-bearing pages (9,10,12,27,28,
-- 30,321) were verified two ways: (1) page dimensions unchanged (595.5x842, matches
-- old field_map), and (2) the old field_map's predicted box positions land within
-- 1.5pt of the new file's actual underline/line positions on every one of those pages
-- -- so those 20 field entries are copied verbatim, unchanged from migration 0014.
--
-- New file uploaded to templates/onboarding-doc-v3.pdf, sha256 verified round-trip
-- after upload (fe1f5884...cc3ff3), byte_size 2938125.

ALTER TABLE nda_templates
  ADD COLUMN IF NOT EXISTS expiry_policy text NOT NULL DEFAULT '24h'
    CHECK (expiry_policy IN ('24h', 'same_day'));

UPDATE nda_templates SET is_active = false, retired_at = now() WHERE is_active = true;

WITH prev AS (
  SELECT version
  FROM nda_templates
  WHERE storage_path = 'templates/onboarding-doc-v2.pdf'
  ORDER BY version DESC
  LIMIT 1
)
INSERT INTO nda_templates
    (version, label, storage_bucket, storage_path, content_sha256, byte_size,
     page_count, field_map, is_active, published_by, expiry_policy)
SELECT
    prev.version + 1,
    'Onboarding Documents (AUP, Disciplinary Action, Code of Ethics, Code of Conduct, NDA)',
    'nda-signing',
    'templates/onboarding-doc-v3.pdf',
    'fe1f58840a6f38b166d836046cd99682debf935c6841aa2dab3617bf19cc3ff3',
    2938125,
    333,
    '[{"field_key": "p9_date_1", "kind": "date", "page_index": 9, "x": 0.2683, "y": 0.4807, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p9_full_name_1", "kind": "full_name", "page_index": 9, "x": 0.2683, "y": 0.3679, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p9_signature_1", "kind": "signature", "page_index": 9, "x": 0.2683, "y": 0.4245, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p10_date_1", "kind": "date", "page_index": 10, "x": 0.44, "y": 0.7015, "w": 0.1805, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p10_full_name_1", "kind": "full_name", "page_index": 10, "x": 0.4392, "y": 0.6682, "w": 0.1813, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_date_1", "kind": "date", "page_index": 12, "x": 0.2683, "y": 0.5078, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_full_name_1", "kind": "full_name", "page_index": 12, "x": 0.2683, "y": 0.3949, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_signature_1", "kind": "signature", "page_index": 12, "x": 0.2683, "y": 0.4519, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_date_1", "kind": "date", "page_index": 16, "x": 0.2272, "y": 0.3962, "w": 0.1549, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_full_name_1", "kind": "full_name", "page_index": 16, "x": 0.1868, "y": 0.3512, "w": 0.1921, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_signature_1", "kind": "signature", "page_index": 16, "x": 0.2292, "y": 0.3714, "w": 0.1496, "h": 0.019, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_date_1", "kind": "date", "page_index": 27, "x": 0.1241, "y": 0.7132, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_full_name_1", "kind": "full_name", "page_index": 27, "x": 0.1241, "y": 0.6004, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_signature_1", "kind": "signature", "page_index": 27, "x": 0.17, "y": 0.6584, "w": 0.1991, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p28_date_1", "kind": "date", "page_index": 28, "x": 0.3409, "y": 0.7015, "w": 0.203, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p28_full_name_1", "kind": "full_name", "page_index": 28, "x": 0.4392, "y": 0.6682, "w": 0.2046, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_date_1", "kind": "date", "page_index": 30, "x": 0.1241, "y": 0.2682, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_full_name_1", "kind": "full_name", "page_index": 30, "x": 0.1241, "y": 0.1553, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_signature_1", "kind": "signature", "page_index": 30, "x": 0.17, "y": 0.212, "w": 0.1999, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_date_1", "kind": "date", "page_index": 32, "x": 0.2272, "y": 0.856, "w": 0.1549, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_full_name_1", "kind": "full_name", "page_index": 32, "x": 0.1868, "y": 0.8127, "w": 0.1921, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_signature_1", "kind": "signature", "page_index": 32, "x": 0.2292, "y": 0.8321, "w": 0.1496, "h": 0.019, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_date_1", "kind": "date", "page_index": 321, "x": 0.2683, "y": 0.2704, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_full_name_1", "kind": "full_name", "page_index": 321, "x": 0.2683, "y": 0.1576, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_signature_1", "kind": "signature", "page_index": 321, "x": 0.2683, "y": 0.2146, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_date_1", "kind": "date", "page_index": 329, "x": 0.5542, "y": 0.4386, "w": 0.3003, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_full_name_1", "kind": "full_name", "page_index": 329, "x": 0.5014, "y": 0.2454, "w": 0.2354, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_signature_1", "kind": "signature", "page_index": 329, "x": 0.5014, "y": 0.3062, "w": 0.3446, "h": 0.0356, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_text_1", "kind": "text", "page_index": 329, "x": 0.5014, "y": 0.4946, "w": 0.353, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0, "label": "Address"}, {"field_key": "p329_text_2", "kind": "text", "page_index": 329, "x": 0.5014, "y": 0.5103, "w": 0.353, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0, "label": "Address"}, {"field_key": "p330_date_1", "kind": "date", "page_index": 330, "x": 0.1663, "y": 0.8447, "w": 0.2519, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p330_full_name_1", "kind": "full_name", "page_index": 330, "x": 0.2821, "y": 0.8153, "w": 0.3359, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p330_signature_1", "kind": "signature", "page_index": 330, "x": 0.309, "y": 0.7628, "w": 0.309, "h": 0.0356, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}]'::jsonb,
    true,
    'sadiq.a@talview.com',
    '24h'
FROM prev;
