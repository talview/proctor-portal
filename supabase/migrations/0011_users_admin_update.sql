-- Lets an admin change another user's role/vendor directly from the Users page.
-- Deletion still goes through the delete-user Edge Function since removing the
-- auth.users row requires the service role.

CREATE POLICY users_admin_update ON users FOR UPDATE TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');
