-- Admin "Set password directly" user creation (invite-user/index.ts, mode:
-- 'password') hands an admin-visible temporary password to a new account with
-- nothing forcing it to ever be changed -- unlike mode: 'invite', which already
-- forces the person to set their own password via AcceptInvitePage before they
-- can use the app. This column lets the app gate on the same "must set your own
-- password before proceeding" requirement for the password-mode path too.
alter table users add column if not exists must_change_password boolean not null default false;

-- Self-service only: a user clears their own flag right after successfully
-- changing their password (see ChangePasswordPage.tsx). Mirrors
-- update_user_name's write-through-RPC pattern -- direct writes to `users` are
-- locked down (migration 0060), so this is the only path that can clear it.
create or replace function mark_password_changed()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  UPDATE users SET must_change_password = false WHERE id = auth.uid();
END;
$function$;

revoke all on function mark_password_changed() from public;
grant execute on function mark_password_changed() to authenticated;
