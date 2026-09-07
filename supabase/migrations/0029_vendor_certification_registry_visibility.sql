-- Vendors now get nav access to Certification > Client SOP > Registry (read-only --
-- Certify stays admin/coordinator-only, unaffected here), so they can check which of
-- their own proctors are already certified for which customers before responding to a
-- customer requirement.
--
-- proctor_certifications_select was previously `USING (true)` -- fully open to any
-- authenticated user, matching the page's own total lack of gating up to now. The
-- Registry page's client-side code already joins certifications against the (RLS-
-- scoped) proctors list and silently drops any certification whose proctor isn't
-- visible, so today's UI never actually rendered another vendor's data -- but the raw
-- network response did carry it to the browser. Tightened to match the proctors
-- table's own vendor-scoping pattern, now that a vendor page is actually reading this
-- table: admin/coordinator keep full visibility, vendor is scoped to certifications
-- for proctors managed by their own vendor.
--
-- customers table is untouched -- vendors need to see customer names to know which
-- customer their proctor is certified for, and it was already broadly readable by
-- design (no write access, matching CustomersPage's existing admin-only gate).

DROP POLICY IF EXISTS proctor_certifications_select ON proctor_certifications;

CREATE POLICY proctor_certifications_select ON proctor_certifications FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR proctor_id IN (
      SELECT pid FROM proctors
      WHERE pid IS NOT NULL
        AND (managed_by = current_user_vendor_name() OR vendor = current_user_vendor_name())
    )
  );
