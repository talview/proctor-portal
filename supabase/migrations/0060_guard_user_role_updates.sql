-- The role-change flow (UsersPage's ChangeRoleModal) updated public.users directly
-- via the client, governed only by the users_admin_update RLS policy -- which just
-- checks current_user_role() = 'admin', with no protection at all against an admin
-- demoting themselves, or demoting the last remaining admin. delete-user (the edge
-- function) already guards both of those exact cases for deletion; role changes had
-- neither guard, on either path (client or RLS) -- a single click could leave the
-- whole app with zero admins able to manage roles/access admin-only pages ever again.
create or replace function update_user_role(p_user_id uuid, p_role text, p_vendor_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_current_role text;
  v_admin_count int;
BEGIN
  IF COALESCE(current_user_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can change user roles';
  END IF;

  IF p_role NOT IN ('admin', 'coordinator', 'vendor') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  IF p_role = 'vendor' AND p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'A vendor role requires a vendor';
  END IF;

  SELECT role INTO v_current_role FROM users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Nothing to guard if the role isn't actually changing away from admin.
  IF v_current_role = 'admin' AND p_role <> 'admin' THEN
    IF p_user_id = auth.uid() THEN
      RAISE EXCEPTION 'You cannot change your own admin role';
    END IF;

    SELECT count(*) INTO v_admin_count FROM users WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot change the role of the last remaining admin account';
    END IF;
  END IF;

  UPDATE users
  SET role = p_role, vendor_id = (CASE WHEN p_role = 'vendor' THEN p_vendor_id ELSE NULL END)
  WHERE id = p_user_id;
END;
$function$;

-- The RPC is now the only permitted write path for a role change -- the previous
-- direct-update RLS policy (current_user_role() = 'admin', no self/last-admin guard)
-- would otherwise still let an admin bypass the RPC entirely via a raw client update.
alter policy users_admin_update on users
  using (false)
  with check (false);
