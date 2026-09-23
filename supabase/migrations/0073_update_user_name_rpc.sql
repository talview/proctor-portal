-- users_admin_update was locked to `using (false) with check (false)` by migration
-- 0060 -- the only permitted write path to the users table (besides service-role
-- edge functions) is a purpose-built RPC. This adds one for name: self-service
-- (a user setting their own display name) or an admin setting anyone's, matching
-- the same current_user_role() check update_user_role already uses.
create or replace function update_user_name(p_user_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF p_user_id <> auth.uid() AND COALESCE(current_user_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'You can only change your own name';
  END IF;

  UPDATE users SET name = NULLIF(TRIM(p_name), '') WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
END;
$function$;

revoke all on function update_user_name(uuid, text) from public;
grant execute on function update_user_name(uuid, text) to authenticated;
