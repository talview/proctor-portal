-- Live-testing feedback after 0025 went out:
-- 1. The AUP cover page (page_index 0: "ACCEPTABLE USE POLICY" / NAME: / DATE:) and the
--    CIIA/NDA's own cover page (page_index 322: "Employee Name:" / "Effective Date:")
--    were never in the field_map at all -- a gap that predates this session's work
--    (0014's original mapping missed them), not something 0025 introduced. Found by
--    re-scanning every one of the 333 pages for bare "NAME:"/"DATE:" label lines with
--    nothing filled in after them (cross-checked against a broader keyword scan to
--    rule out false positives from ordinary policy prose that happens to mention
--    "name"/"date"/"signature"). Coordinates pixel-verified the same way as 0025's.
--
-- 2. p329_text_1 and p329_text_2 (the two-line Address block on the main CIIA
--    signature page) shared the label "Address" -- the frontend groups same-page text
--    fields by label so a repeated label anywhere in the document reuses one value,
--    which is exactly wrong here: these are two independent lines of one address, not
--    the same value repeated. Relabeled "Address Line 1" / "Address Line 2" so each is
--    its own field; no frontend change needed, the existing by-label grouping now does
--    the right thing on its own.

-- storage_path is UNIQUE, and the underlying bytes genuinely haven't changed (only the
-- field_map has) -- re-uploaded the identical file under a new path
-- (templates/onboarding-doc-v3-r2.pdf) rather than reuse the retired row's path, and
-- verified the round-tripped hash still matches before writing this migration.

UPDATE nda_templates SET is_active = false, retired_at = now() WHERE is_active = true;

WITH prev AS (
  SELECT version
  FROM nda_templates
  WHERE storage_path = 'templates/onboarding-doc-v3.pdf'
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
    'templates/onboarding-doc-v3-r2.pdf',
    'fe1f58840a6f38b166d836046cd99682debf935c6841aa2dab3617bf19cc3ff3',
    2938125,
    333,
    '[{"field_key": "p0_date_1", "kind": "date", "page_index": 0, "x": 0.6975, "y": 0.8135, "w": 0.2515, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p0_full_name_1", "kind": "full_name", "page_index": 0, "x": 0.7031, "y": 0.79, "w": 0.2415, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p9_date_1", "kind": "date", "page_index": 9, "x": 0.2683, "y": 0.4807, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p9_full_name_1", "kind": "full_name", "page_index": 9, "x": 0.2683, "y": 0.3679, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p9_signature_1", "kind": "signature", "page_index": 9, "x": 0.2683, "y": 0.4245, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p10_date_1", "kind": "date", "page_index": 10, "x": 0.44, "y": 0.7015, "w": 0.1805, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p10_full_name_1", "kind": "full_name", "page_index": 10, "x": 0.4392, "y": 0.6682, "w": 0.1813, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_date_1", "kind": "date", "page_index": 12, "x": 0.2683, "y": 0.5078, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_full_name_1", "kind": "full_name", "page_index": 12, "x": 0.2683, "y": 0.3949, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p12_signature_1", "kind": "signature", "page_index": 12, "x": 0.2683, "y": 0.4519, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_date_1", "kind": "date", "page_index": 16, "x": 0.2272, "y": 0.3962, "w": 0.1549, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_full_name_1", "kind": "full_name", "page_index": 16, "x": 0.1868, "y": 0.3512, "w": 0.1921, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p16_signature_1", "kind": "signature", "page_index": 16, "x": 0.2292, "y": 0.3714, "w": 0.1496, "h": 0.019, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_date_1", "kind": "date", "page_index": 27, "x": 0.1241, "y": 0.7132, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_full_name_1", "kind": "full_name", "page_index": 27, "x": 0.1241, "y": 0.6004, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p27_signature_1", "kind": "signature", "page_index": 27, "x": 0.17, "y": 0.6584, "w": 0.1991, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p28_date_1", "kind": "date", "page_index": 28, "x": 0.3409, "y": 0.7015, "w": 0.203, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p28_full_name_1", "kind": "full_name", "page_index": 28, "x": 0.4392, "y": 0.6682, "w": 0.2046, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_date_1", "kind": "date", "page_index": 30, "x": 0.1241, "y": 0.2682, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_full_name_1", "kind": "full_name", "page_index": 30, "x": 0.1241, "y": 0.1553, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p30_signature_1", "kind": "signature", "page_index": 30, "x": 0.17, "y": 0.212, "w": 0.1999, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_date_1", "kind": "date", "page_index": 32, "x": 0.2272, "y": 0.856, "w": 0.1549, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_full_name_1", "kind": "full_name", "page_index": 32, "x": 0.1868, "y": 0.8127, "w": 0.1921, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p32_signature_1", "kind": "signature", "page_index": 32, "x": 0.2292, "y": 0.8321, "w": 0.1496, "h": 0.019, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_date_1", "kind": "date", "page_index": 321, "x": 0.2683, "y": 0.2704, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_full_name_1", "kind": "full_name", "page_index": 321, "x": 0.2683, "y": 0.1576, "w": 0.2458, "h": 0.02, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p321_signature_1", "kind": "signature", "page_index": 321, "x": 0.2683, "y": 0.2146, "w": 0.2458, "h": 0.038, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p322_date_1", "kind": "date", "page_index": 322, "x": 0.571, "y": 0.2334, "w": 0.3023, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p322_full_name_1", "kind": "full_name", "page_index": 322, "x": 0.5794, "y": 0.2037, "w": 0.3359, "h": 0.0138, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_date_1", "kind": "date", "page_index": 329, "x": 0.5542, "y": 0.4386, "w": 0.3003, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_full_name_1", "kind": "full_name", "page_index": 329, "x": 0.5014, "y": 0.2454, "w": 0.2354, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_signature_1", "kind": "signature", "page_index": 329, "x": 0.5014, "y": 0.3062, "w": 0.3446, "h": 0.0356, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p329_text_1", "kind": "text", "page_index": 329, "x": 0.5014, "y": 0.4946, "w": 0.353, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0, "label": "Address Line 1"}, {"field_key": "p329_text_2", "kind": "text", "page_index": 329, "x": 0.5014, "y": 0.5103, "w": 0.353, "h": 0.0166, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0, "label": "Address Line 2"}, {"field_key": "p330_date_1", "kind": "date", "page_index": 330, "x": 0.1663, "y": 0.8447, "w": 0.2519, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p330_full_name_1", "kind": "full_name", "page_index": 330, "x": 0.2821, "y": 0.8153, "w": 0.3359, "h": 0.0139, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}, {"field_key": "p330_signature_1", "kind": "signature", "page_index": 330, "x": 0.309, "y": 0.7628, "w": 0.309, "h": 0.0356, "page_w": 595.5, "page_h": 842.0, "page_rotation": 0}]'::jsonb,
    true,
    'sadiq.a@talview.com',
    '24h'
FROM prev;
