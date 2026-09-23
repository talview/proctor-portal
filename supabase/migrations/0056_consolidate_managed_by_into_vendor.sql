-- Consolidates proctors' two vendor-identity columns into one. `managed_by` has been
-- the actually-authoritative column for a long time (every current query/filter uses
-- it); `vendor` is a legacy column from an earlier, pre-React version of this app
-- ("Used in HTML app" per the frontend type comment), kept only as a fallback that was
-- never cleaned up. Verified live before writing this: all 109 proctor rows already
-- have managed_by populated, zero rows rely on vendor alone, and zero rows have the
-- two values differing -- consolidating is a pure rename with no data-loss risk.
--
-- Ends with a single column literally named `vendor`, matching the terminology
-- already standardized everywhere in the UI, instead of the UI saying "Vendor" while
-- the schema still says `managed_by`.
--
-- Order matters here: views and RLS policies are real dependencies on the columns
-- they reference (a DROP COLUMN would be refused while they still touch `vendor`), so
-- both are simplified down to `managed_by`-only *first* -- then the old `vendor`
-- column is dropped, then `managed_by` is renamed to `vendor`. Postgres automatically
-- updates the internal column reference inside views/policies when the column they
-- depend on is renamed, so nothing further is needed for those. Function bodies are
-- NOT auto-updated by a rename (they're stored as raw source text, not a compiled
-- dependency) -- those are corrected explicitly at the end, once the column is
-- already named `vendor`.

-- ============================================================
-- 1. Views -- simplify away the fallback, `managed_by` only for now
-- ============================================================
create or replace view latest_evaluation_per_proctor
with (security_invoker = true) as
select
  id, proctor_id, eval_type, panel_user, scheduled_date, scheduled_time, conducted_date,
  result, attempt_number, comment, created_at, created_by, status, certified_date,
  score_obtained, score_out_of, overridden_by, overridden_at, group_id, session_code,
  candidate_id, section_id, result_url,
  proctor_name, proctor_email, proctor_vendor, proctor_type, history
from (
  select
    pe.*,
    p.name as proctor_name,
    p.email as proctor_email,
    p.managed_by as proctor_vendor,
    p.ptype as proctor_type,
    row_number() over (partition by pe.proctor_id, pe.eval_type order by pe.attempt_number desc) as rn,
    jsonb_agg(
      jsonb_build_object(
        'id', pe.id, 'attempt_number', pe.attempt_number, 'result', pe.result,
        'scheduled_date', pe.scheduled_date, 'conducted_date', pe.conducted_date,
        'created_at', pe.created_at, 'panel_user', pe.panel_user, 'comment', pe.comment,
        'score_obtained', pe.score_obtained, 'score_out_of', pe.score_out_of,
        'overridden_by', pe.overridden_by, 'overridden_at', pe.overridden_at,
        'result_url', pe.result_url, 'certified_date', pe.certified_date
      )
    ) over (
      partition by pe.proctor_id, pe.eval_type
      order by pe.attempt_number desc
      rows between 1 following and unbounded following
    ) as history
  from proctor_evaluations pe
  join proctors p on p.id = pe.proctor_id
  where pe.result is not null
) ranked
where rn = 1;

create or replace view certification_registry
with (security_invoker = true) as
select
  p.pid,
  p.name,
  p.managed_by as vendor,
  p.ptype,
  p.vat as verified_date,
  p.aat as activated_date,
  array_agg(distinct pc.customer_id) as customer_ids,
  jsonb_agg(
    jsonb_build_object(
      'customer_id', pc.customer_id,
      'customer_name', pc.customer_name,
      'certified_date', pc.certified_date,
      'version_certified', pc.version_certified
    )
    order by pc.customer_name
  ) as certifications
from proctor_certifications pc
join customers c on c.id = pc.customer_id
join proctors p on p.pid = pc.proctor_id
where pc.status = 'certified'
  and pc.version_certified >= c.current_version
group by p.pid, p.name, p.managed_by, p.ptype, p.vat, p.aat;

-- ============================================================
-- 2. RLS policies -- drop the redundant `OR vendor = ...` branch
-- ============================================================
alter policy proctors_select on proctors using (
  current_user_role() = any (array['admin','coordinator'])
  or managed_by = current_user_vendor_name()
);

alter policy proctor_evaluations_select on proctor_evaluations using (
  current_user_role() = any (array['admin','coordinator'])
  or exists (
    select 1 from proctors p
    where p.id = proctor_evaluations.proctor_id
      and p.managed_by = current_user_vendor_name()
  )
);

alter policy nda_sessions_select on nda_signing_sessions using (
  current_user_role() = any (array['admin','coordinator'])
  or exists (
    select 1 from proctors p
    where p.id = nda_signing_sessions.proctor_id
      and p.managed_by = current_user_vendor_name()
  )
);

alter policy nda_events_select on nda_signing_events using (
  current_user_role() = any (array['admin','coordinator'])
  or exists (
    select 1 from nda_signing_sessions s join proctors p on p.id = s.proctor_id
    where s.id = nda_signing_events.session_id
      and p.managed_by = current_user_vendor_name()
  )
);

alter policy nda_documents_select on nda_session_documents using (
  current_user_role() = any (array['admin','coordinator'])
  or exists (
    select 1 from nda_signing_sessions s join proctors p on p.id = s.proctor_id
    where s.id = nda_session_documents.session_id
      and p.managed_by = current_user_vendor_name()
  )
);

alter policy proctor_certifications_select on proctor_certifications using (
  current_user_role() = any (array['admin','coordinator'])
  or proctor_id in (
    select proctors.pid from proctors
    where proctors.pid is not null
      and proctors.managed_by = current_user_vendor_name()
  )
);

-- ============================================================
-- 3. Drop the old column, rename the authoritative one, rename its index
-- ============================================================
alter table proctors drop column vendor;
alter table proctors rename column managed_by to vendor;
alter index idx_proctors_managed_by rename to idx_proctors_vendor;

-- ============================================================
-- 4. Functions -- these reference the column by raw source text, not a tracked
-- dependency, so a rename alone would leave them broken (referencing a field that no
-- longer exists). Rewritten here now that the column is actually named `vendor`.
-- ============================================================
create or replace function assign_proctor_id(p_proctor_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_prefix text;
  v_max int;
  v_new_pid text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can assign a Proctor ID';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF NOT v_proctor.vendor_verified THEN RAISE EXCEPTION 'Proctor must be verified before activation'; END IF;
  IF NULLIF(v_proctor.pid, '') IS NOT NULL THEN RAISE EXCEPTION 'Proctor already has an ID'; END IF;

  SELECT code INTO v_prefix FROM vendors WHERE name = v_proctor.vendor LIMIT 1;
  IF v_prefix IS NULL THEN
    v_prefix := upper(left(COALESCE(v_proctor.vendor, 'GEN'), 3));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_prefix));

  SELECT COALESCE(MAX((regexp_match(pid, '-(\d+)$'))[1]::int), 0)
  INTO v_max
  FROM proctors WHERE pid LIKE v_prefix || '-%';

  v_new_pid := v_prefix || '-' || lpad((v_max + 1)::text, 4, '0');

  UPDATE proctors SET
    pid = v_new_pid,
    status = 'Active',
    stage = 3,
    aat = now(),
    upd = now()
  WHERE id = p_proctor_id;

  RETURN v_new_pid;
END;
$function$;

create or replace function check_aadhaar_duplicates(p_aadhaars text[])
returns table(input_aadhaar text, id text, name text, vendor text, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF COALESCE(current_user_role(), '') NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  RETURN QUERY
  SELECT a.val, p.id, p.name, p.vendor, p.status
  FROM unnest(p_aadhaars) AS a(val)
  JOIN proctors p ON p.aadhaar = hash_aadhaar(a.val) AND p.status <> 'Archived';
END;
$function$;

create or replace function mark_eval_ready(p_proctor_id text, p_eval_type text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  IF p_eval_type NOT IN ('demo', 'assessment') THEN
    RAISE EXCEPTION 'Invalid eval_type';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM v_proctor.vendor THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  IF p_eval_type = 'demo' THEN
    UPDATE proctors SET demo_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  ELSE
    UPDATE proctors SET assessment_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  END IF;
END;
$function$;

create or replace function re_onboard_proctor(p_old_proctor_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_old proctors%ROWTYPE;
  v_new_id text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can re-onboard proctors';
  END IF;

  SELECT * INTO v_old FROM proctors WHERE id = p_old_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  UPDATE proctors SET status = 'Archived', upd = now() WHERE id = p_old_proctor_id;

  v_new_id := gen_random_uuid()::text;

  INSERT INTO proctors (
    id, name, aadhaar, dob, gender, ptype, vendor, phone, email, city, state,
    notes, status, stage, by_user, at, upd
  ) VALUES (
    v_new_id, v_old.name, v_old.aadhaar, v_old.dob, v_old.gender, v_old.ptype, v_old.vendor,
    v_old.phone, v_old.email, v_old.city, v_old.state,
    'Re-onboarded from ' || COALESCE(NULLIF(v_old.pid, ''), 'previous record'),
    'In Progress', 0, auth.jwt() ->> 'email', now(), now()
  );

  RETURN v_new_id;
END;
$function$;

create or replace function submit_bgv(p_proctor_id text, p_file_url text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM v_proctor.vendor THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  UPDATE proctors SET bgv = p_file_url, upd = now() WHERE id = p_proctor_id;
END;
$function$;

create or replace function verify_proctor(p_proctor_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_docs_ok boolean;
BEGIN
  IF current_user_role() NOT IN ('admin', 'vendor') THEN
    RAISE EXCEPTION 'Only admins and vendors can verify proctors';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor'
     AND v_proctor.vendor IS DISTINCT FROM current_user_vendor_name() THEN
    RAISE EXCEPTION 'You can only verify your own vendor''s proctors';
  END IF;

  v_docs_ok := NULLIF(v_proctor.doc_resume, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_passport_photo, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_grad_cert, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_aadhaar_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_pan_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_eye_test, '') IS NOT NULL;

  IF NOT v_docs_ok THEN RAISE EXCEPTION 'Documents not complete'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF v_proctor.vendor_verified THEN RAISE EXCEPTION 'Already verified'; END IF;

  UPDATE proctors SET
    vendor_verified = true,
    vendor_verified_by = auth.jwt() ->> 'email',
    vendor_verified_at = now(),
    status = 'Verified',
    stage = 2,
    upd = now()
  WHERE id = p_proctor_id;
END;
$function$;
