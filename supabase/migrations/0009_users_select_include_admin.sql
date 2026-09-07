-- Panel-assignment dropdowns (Evaluations scheduling, Workspace reschedule) need to list
-- admins alongside coordinators now (per user decision: skip multi-role, just let admins
-- show up in the same list). The existing users_select policy only exposed role='coordinator'
-- rows to non-admin callers, not role='admin' -- widen it.

DROP POLICY IF EXISTS users_select ON users;

-- Note: role IN ('coordinator','admin') makes those rows visible to ANY authenticated
-- caller (needed for the panel dropdown); current_user_role() = 'admin' separately lets
-- an admin see vendor-role rows too, for the Users management page.
CREATE POLICY users_select ON users FOR SELECT TO authenticated
  USING (id = auth.uid() OR role IN ('coordinator', 'admin') OR current_user_role() = 'admin');
