-- Replace every "USING (true)" / anon-open policy with real role/vendor/ownership scoped
-- policies now that real Supabase Auth sessions exist (auth.uid() is populated).

ALTER TABLE user_notes ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);

-- ============================================================
-- Drop every old permissive policy
-- ============================================================
DROP POLICY IF EXISTS admin_only_config ON app_config;
DROP POLICY IF EXISTS service_role_all_logs ON audit_log;
DROP POLICY IF EXISTS "Allow all for anon" ON customers;
DROP POLICY IF EXISTS auth_read_final_form ON final_onboarding_forms;
DROP POLICY IF EXISTS auth_update_final_form ON final_onboarding_forms;
DROP POLICY IF EXISTS public_insert_final_form ON final_onboarding_forms;
DROP POLICY IF EXISTS "Allow all for anon" ON proctor_certifications;
DROP POLICY IF EXISTS "Allow all for anon" ON proctor_evaluations;
DROP POLICY IF EXISTS service_role_all ON proctors;
DROP POLICY IF EXISTS "Allow all for anon" ON user_notes;
DROP POLICY IF EXISTS allow_read_users ON users;
DROP POLICY IF EXISTS public_all_vendor_contacts ON vendor_contacts;
DROP POLICY IF EXISTS public_read_vendors ON vendors;
DROP POLICY IF EXISTS public_write_vendors ON vendors;

-- ============================================================
-- users -- own row, coordinator rows (needed for panel dropdowns), or admin sees all.
-- No direct write grants: all account creation goes through the invite-user Edge
-- Function using the service role, which bypasses RLS entirely.
-- ============================================================
CREATE POLICY users_select ON users FOR SELECT TO authenticated
  USING (id = auth.uid() OR role = 'coordinator' OR current_user_role() = 'admin');

-- ============================================================
-- proctors -- row-scoped by vendor for vendor role; admin/coordinator see everything.
-- Only a plain admin field-edit stays as a direct UPDATE grant; every lifecycle
-- transition (verify, NDA, assign ID, offboard, re-onboard, mark ready, BGV) goes
-- through the SECURITY DEFINER functions added in the previous migration, which
-- bypass RLS and enforce their own role + precondition checks.
-- ============================================================
CREATE POLICY proctors_select ON proctors FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR managed_by = current_user_vendor_name()
    OR vendor = current_user_vendor_name()
  );

CREATE POLICY proctors_insert ON proctors FOR INSERT TO authenticated
  WITH CHECK (
    current_user_role() IN ('admin', 'coordinator')
    OR (current_user_role() = 'vendor' AND (managed_by = current_user_vendor_name() OR vendor = current_user_vendor_name()))
  );

CREATE POLICY proctors_admin_update ON proctors FOR UPDATE TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- ============================================================
-- proctor_evaluations -- admin/coordinator manage; vendor sees only their own proctors'
-- evaluations. Result submission/override/reschedule go through their own functions.
-- ============================================================
CREATE POLICY proctor_evaluations_select ON proctor_evaluations FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR EXISTS (
      SELECT 1 FROM proctors p
      WHERE p.id = proctor_evaluations.proctor_id
        AND (p.managed_by = current_user_vendor_name() OR p.vendor = current_user_vendor_name())
    )
  );

CREATE POLICY proctor_evaluations_write ON proctor_evaluations FOR INSERT TO authenticated
  WITH CHECK (current_user_role() IN ('admin', 'coordinator'));

CREATE POLICY proctor_evaluations_update ON proctor_evaluations FOR UPDATE TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'))
  WITH CHECK (current_user_role() IN ('admin', 'coordinator'));

-- ============================================================
-- proctor_certifications -- read is broad (matches today's ungated Certifications page),
-- write/delete is admin/coordinator (no vendor UI path exists for this today).
-- ============================================================
CREATE POLICY proctor_certifications_select ON proctor_certifications FOR SELECT TO authenticated
  USING (true);

CREATE POLICY proctor_certifications_insert ON proctor_certifications FOR INSERT TO authenticated
  WITH CHECK (current_user_role() IN ('admin', 'coordinator'));

CREATE POLICY proctor_certifications_update ON proctor_certifications FOR UPDATE TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'))
  WITH CHECK (current_user_role() IN ('admin', 'coordinator'));

CREATE POLICY proctor_certifications_delete ON proctor_certifications FOR DELETE TO authenticated
  USING (current_user_role() = 'admin');

-- ============================================================
-- audit_log -- admin-only read. No direct write grant at all: writes only via
-- log_audit(), which derives the acting user from the session, not the client.
-- No UPDATE/DELETE ever -- the trail is meant to be immutable.
-- ============================================================
CREATE POLICY audit_log_select ON audit_log FOR SELECT TO authenticated
  USING (current_user_role() = 'admin');

-- ============================================================
-- customers -- read matches today's ungated Certifications page; write is admin-only
-- (matches CustomersPage's existing page-level admin gate).
-- ============================================================
CREATE POLICY customers_select ON customers FOR SELECT TO authenticated
  USING (true);

CREATE POLICY customers_write ON customers FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- ============================================================
-- vendors -- read is broad (used by every role for the Managed By dropdown); write
-- is admin-only (matches VendorsPage's existing page-level admin gate).
-- ============================================================
CREATE POLICY vendors_select ON vendors FOR SELECT TO authenticated
  USING (true);

CREATE POLICY vendors_write ON vendors FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- ============================================================
-- vendor_contacts -- admin-only in both directions (only VendorsPage touches this,
-- and that page is already admin-gated).
-- ============================================================
CREATE POLICY vendor_contacts_all ON vendor_contacts FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- ============================================================
-- app_config -- admin-only, authenticated only (no anon at all).
-- ============================================================
CREATE POLICY app_config_all ON app_config FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

-- ============================================================
-- user_notes -- strictly own-row, now that a real user_id exists to key off.
-- ============================================================
CREATE POLICY user_notes_all ON user_notes FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- final_onboarding_forms -- no frontend or Edge Function reference found anywhere;
-- left with no policies at all (default deny) until confirmed safe to drop entirely.
-- ============================================================

-- Login has fully cut over to native Supabase Auth (email + password) -- the old
-- custom RPC is no longer reachable from the client.
REVOKE EXECUTE ON FUNCTION verify_login(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION verify_login(text, text) FROM PUBLIC;
