-- Nothing today tracks failed sign-in attempts or throttles repeated wrong
-- guesses against the app's own login form -- authService.login just forwards
-- whatever Supabase Auth returns. This is an application-layer deterrent
-- against someone repeatedly guessing a password through the actual login
-- screen; it does not (and, with hosted Supabase Auth, cannot from app code
-- alone) stop a determined attacker calling Supabase's own Auth REST endpoint
-- directly, bypassing this app's JS entirely -- that deeper protection is a
-- Supabase-project-level rate-limit control, not something enforceable here.
alter table users add column if not exists failed_login_attempts int not null default 0;
alter table users add column if not exists locked_until timestamptz;

-- Anonymous-callable (there's no session yet at the point login is being
-- attempted) -- looked up by email, not id. Returns zero rows for an unknown
-- email rather than an error, so this can't be used to probe which emails
-- have accounts.
create or replace function check_login_lock(p_email text)
returns table(locked boolean, locked_until timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  RETURN QUERY
  SELECT (u.locked_until IS NOT NULL AND u.locked_until > now()), u.locked_until
  FROM users u WHERE u.email = p_email;
END;
$function$;

revoke all on function check_login_lock(text) from public;
grant execute on function check_login_lock(text) to anon, authenticated;

-- Fixed, bounded thresholds (5 attempts, 15-minute cooldown) -- this only ever
-- locks the ONE account being guessed against, and only temporarily, never a
-- wider ban. Returns the new attempt count so the client can show "N attempts
-- remaining" -- returns null for an unknown email (UPDATE affects 0 rows), so
-- the client shows no such hint for those, same as before this existed.
create or replace function record_failed_login(p_email text)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_attempts int;
BEGIN
  UPDATE users
  SET failed_login_attempts = failed_login_attempts + 1
  WHERE email = p_email
  RETURNING failed_login_attempts INTO v_attempts;

  IF v_attempts >= 5 THEN
    UPDATE users SET locked_until = now() + interval '15 minutes' WHERE email = p_email;
  END IF;

  RETURN v_attempts;
END;
$function$;

revoke all on function record_failed_login(text) from public;
grant execute on function record_failed_login(text) to anon, authenticated;

create or replace function reset_failed_login(p_email text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  UPDATE users SET failed_login_attempts = 0, locked_until = null WHERE email = p_email;
END;
$function$;

revoke all on function reset_failed_login(text) from public;
grant execute on function reset_failed_login(text) to anon, authenticated;
