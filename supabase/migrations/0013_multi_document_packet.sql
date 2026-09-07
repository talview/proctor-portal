-- Generalizes the field_map 'place' kind into a generic 'text' kind with a required
-- label (e.g. "Address") -- every field sharing the same label is filled with one
-- signer-entered value, matching the reference signing flow's "Address" field. The
-- template itself stays a single combined PDF (all onboarding documents already
-- merged into one file, as supplied) -- no change to the one-active-template design.

COMMENT ON COLUMN nda_templates.field_map IS
  '[{ field_key, kind, label?, page_index, x, y, w, h, page_w, page_h, page_rotation }]. '
  'x/y/w/h normalised 0..1 against the visual (post-rotation) page box. '
  'kind is a fixed vocabulary: ''signature'' | ''date'' | ''full_name'' | ''text''. '
  '''text'' fields carry a required ''label'' (e.g. "Address") -- every field sharing '
  'the same label is filled with one signer-entered value.';
