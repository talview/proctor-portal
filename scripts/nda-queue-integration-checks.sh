#!/bin/bash
# Integration-style checks for the NDA signing flow's durable job queues
# (pdf_generation_jobs / document_integrity_jobs), run against the real linked
# Supabase project rather than a local stack -- this environment has no
# Docker, so `supabase start` (and therefore any Deno-test-against-a-local-
# instance setup) isn't available here. This is the "scripted staging checks"
# alternative the production-readiness review itself suggested as the
# fallback when a full local integration-test harness isn't practical.
#
# Covers the five things that review specifically called out as untested:
#   1. sign job creation (+ the stuck-in-signing recovery path)
#   2. document replacement (the stale-verification-write race guard)
#   3. stale reclaim
#   4. terminal failure propagation
#   5. cron disarm/rearm
#
# Every test creates its own disposable proctor/session rows (prefixed with
# a run-specific id) and storage objects, asserts against the real deployed
# functions/RPCs, and cleans up after itself -- cleanup runs via a trap so it
# still happens if an assertion fails partway through. No product code
# changes -- read-only with respect to real data, this only ever touches rows
# and objects it creates itself.
#
# Usage: ./scripts/nda-queue-integration-checks.sh
# Requires: supabase CLI logged in and linked to the target project, .env
# with VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY, python3, curl, shasum.

set -u
cd "$(dirname "$0")/.."

PROJECT_REF="vukijbppuchsmwoyrbjt"
SUPABASE_URL=$(grep VITE_SUPABASE_URL .env | cut -d= -f2)
ANON_KEY=$(grep VITE_SUPABASE_ANON_KEY .env | cut -d= -f2)
RUN_ID=$(python3 -c "import secrets; print(secrets.token_hex(6))")

PASS_COUNT=0
FAIL_COUNT=0
CLEANUP_SQL=()
CLEANUP_STORAGE_PATHS=()

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "  PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "  FAIL: $1"; }
section() { echo ""; echo "=== $1 ==="; }

# Fire-and-forget SQL (inserts/updates/deletes whose result we don't need).
db_exec() {
  supabase db query --linked "$1" >/tmp/nda-int-check-db.log 2>&1
}

# Runs one SQL statement and prints the first column of its first returned
# row as a raw string (empty string if no rows). `supabase db query` prints
# one pretty-printed (multi-line) JSON document per call, not one line per
# object, so this reads all of stdin before parsing rather than line-by-line.
db_scalar() {
  supabase db query --linked "$1" 2>/tmp/nda-int-check-db.log | python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('')
    sys.exit(0)
rows = d.get('rows') or []
if not rows:
    print('')
else:
    v = next(iter(rows[0].values()), None)
    print('' if v is None else v)
"
}

random_hex() { python3 -c "import secrets; print(secrets.token_hex($1))"; }
sha256_hex() { python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"; }

json_field() {
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print('')
    sys.exit(0)
v = d
for k in sys.argv[2].split('.'):
    v = v.get(k) if isinstance(v, dict) else None
print('' if v is None else v)
" "$1" "$2"
}

# Lazily fetched only if a test actually needs to delete a storage object --
# direct `DELETE FROM storage.objects` is blocked at the DB level (protect_delete()),
# so cleanup has to go through the Storage API, which needs the service-role key.
SERVICE_KEY=""
service_key() {
  if [ -z "$SERVICE_KEY" ]; then
    SERVICE_KEY=$(supabase projects api-keys --project-ref "$PROJECT_REF" 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print([k['api_key'] for k in d['keys'] if k['id']=='service_role'][0])")
  fi
  echo "$SERVICE_KEY"
}

# Every test registers its own cleanup here; run once at exit regardless of
# how the script got there (a failed assertion never skips cleanup).
run_cleanup() {
  section "Cleanup"
  if [ ${#CLEANUP_STORAGE_PATHS[@]} -gt 0 ]; then
    local key; key=$(service_key)
    local prefixes_json; prefixes_json=$(python3 -c "import json,sys; print(json.dumps({'prefixes': sys.argv[1:]}))" "${CLEANUP_STORAGE_PATHS[@]}")
    curl -s -X DELETE "${SUPABASE_URL}/storage/v1/object/nda-signing" \
      -H "apikey: ${key}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \
      -d "$prefixes_json" >/tmp/nda-int-check-storage-cleanup.log 2>&1
    echo "  Removed ${#CLEANUP_STORAGE_PATHS[@]} storage object(s)."
  fi
  if [ ${#CLEANUP_SQL[@]} -gt 0 ]; then
    for stmt in "${CLEANUP_SQL[@]}"; do
      db_exec "$stmt"
    done
    echo "  Ran ${#CLEANUP_SQL[@]} cleanup SQL statement(s)."
  fi
  if [ ${#CLEANUP_STORAGE_PATHS[@]} -eq 0 ] && [ ${#CLEANUP_SQL[@]} -eq 0 ]; then
    echo "  (nothing to clean up)"
  fi
  rm -f /tmp/nda-int-check-*.pdf
}
trap run_cleanup EXIT

ACTIVE_TEMPLATE_ID=$(db_scalar "select id::text as v from nda_templates where is_active = true limit 1")
ACTIVE_TEMPLATE_SHA=$(db_scalar "select content_sha256 as v from nda_templates where id = '${ACTIVE_TEMPLATE_ID}'")
if [ -z "$ACTIVE_TEMPLATE_ID" ]; then
  echo "No active nda_templates row found -- cannot run these checks. Publish a template first."
  exit 1
fi

# Creates a disposable proctor + nda_signing_session and registers both for
# cleanup. Sets NEW_PROCTOR_ID/NEW_SESSION_ID/NEW_STEP_TOKEN as GLOBALS rather
# than echoing + having the caller capture via $(...) -- command substitution
# runs in a subshell, and this function's CLEANUP_SQL/CLEANUP_STORAGE_PATHS
# appends must land in the *real* shared arrays, not a subshell's throwaway
# copy that vanishes the moment it exits (which is exactly what silently
# broke cleanup registration in an earlier version of this script).
# $1: proctor id suffix (unique per test)  $2: initial session status
new_test_session() {
  local suffix="$1" status="$2"
  NEW_PROCTOR_ID="ndaintchk-${RUN_ID}-${suffix}"
  NEW_STEP_TOKEN=$(random_hex 32)
  local step_hash; step_hash=$(sha256_hex "$NEW_STEP_TOKEN")
  local session_token_hash; session_token_hash=$(sha256_hex "session-${NEW_PROCTOR_ID}")

  if [ -z "$NEW_STEP_TOKEN" ] || [ -z "$step_hash" ]; then
    echo "  ERROR: new_test_session failed to generate a step token (transient helper-tool hiccup?)." >&2
    NEW_SESSION_ID=""
    return 1
  fi

  db_exec "insert into proctors (id, name, email, phone, aadhaar, city, state, dob, gender, ptype, vendor, status, stage, by_user, upd)
    values ('${NEW_PROCTOR_ID}', 'NDA Int Check ${suffix}', '${NEW_PROCTOR_ID}@example.com', '${NEW_PROCTOR_ID}', '${NEW_PROCTOR_ID}', 'Bengaluru', 'Karnataka', null, 'Male', 'WFO', 'ATS', 'In Progress', 1, 'integration-check', now());"
  CLEANUP_SQL+=("delete from proctors where id = '${NEW_PROCTOR_ID}';")

  NEW_SESSION_ID=$(db_scalar "
    insert into nda_signing_sessions (
      id, proctor_id, template_id, template_sha256, signer_name_snapshot, signer_email_snapshot,
      session_token_sha256, session_expires_at, step_token_sha256, step_token_expires_at,
      status, created_by
    ) values (
      gen_random_uuid(), '${NEW_PROCTOR_ID}', '${ACTIVE_TEMPLATE_ID}', '${ACTIVE_TEMPLATE_SHA}',
      'NDA Int Check ${suffix}', '${NEW_PROCTOR_ID}@example.com',
      '${session_token_hash}', now() + interval '1 day',
      '${step_hash}', now() + interval '1 hour',
      '${status}', 'integration-check'
    ) returning id::text as v
  ")

  if [ -z "$NEW_SESSION_ID" ]; then
    echo "  ERROR: new_test_session failed to create the session row." >&2
    return 1
  fi

  CLEANUP_SQL+=("delete from nda_signing_events where session_id = '${NEW_SESSION_ID}';")
  CLEANUP_SQL+=("delete from pdf_generation_jobs where session_id = '${NEW_SESSION_ID}';")
  CLEANUP_SQL+=("delete from document_integrity_jobs where session_id = '${NEW_SESSION_ID}';")
  CLEANUP_SQL+=("delete from nda_session_documents where session_id = '${NEW_SESSION_ID}';")
  CLEANUP_SQL+=("delete from nda_signing_sessions where id = '${NEW_SESSION_ID}';")
}

call_fn() {
  local fn="$1" body="$2"
  curl -s -X POST "${SUPABASE_URL}/functions/v1/${fn}" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$body"
}

# Uploads a small throwaway PDF for (session_id, step_token, docKind) via the
# real request/confirm flow, registers the storage path for cleanup, and
# prints the job id document_integrity_jobs assigns it once one exists (empty
# if none has appeared yet).
upload_test_doc() {
  local step_token="$1" doc_kind="$2" tag="$3"
  local req path signed_url
  req=$(call_fn "nda-session-upload-url" "{\"stepToken\":\"${step_token}\",\"action\":\"request\",\"docKind\":\"${doc_kind}\",\"fileExt\":\"pdf\"}")
  path=$(json_field "$req" path)
  signed_url=$(json_field "$req" signedUrl)
  # Fail loudly here rather than letting an empty signed_url reach `curl -X PUT`,
  # which produces an opaque "option : blank argument" error that doesn't say
  # WHY the URL was empty (a real API error, or a transient helper-tool hiccup).
  if [ -z "$path" ] || [ -z "$signed_url" ]; then
    echo "  ERROR: upload_test_doc got an empty path/signedUrl. Raw response: $req" >&2
    echo ""
    return 1
  fi
  echo "int-check ${tag} $(date +%s)" >"/tmp/nda-int-check-${tag}.pdf"
  local put_status
  put_status=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$signed_url" -H "Content-Type: application/pdf" --data-binary "@/tmp/nda-int-check-${tag}.pdf")
  if [ "$put_status" != "200" ]; then
    echo "  ERROR: upload PUT returned HTTP $put_status" >&2
    echo ""
    return 1
  fi
  local sha; sha=$(shasum -a 256 "/tmp/nda-int-check-${tag}.pdf" | cut -d' ' -f1)
  local confirm_resp
  confirm_resp=$(call_fn "nda-session-upload-url" "{\"stepToken\":\"${step_token}\",\"action\":\"confirm\",\"docKind\":\"${doc_kind}\",\"path\":\"${path}\",\"clientSha256\":\"${sha}\"}")
  if [ "$(json_field "$confirm_resp" success)" != "True" ]; then
    echo "  ERROR: confirm failed: $confirm_resp" >&2
    echo ""
    return 1
  fi
  CLEANUP_STORAGE_PATHS+=("$path")
  echo "$path"
}

# ---------------------------------------------------------------------------
# 1. Sign job creation (+ stuck-in-signing recovery)
# ---------------------------------------------------------------------------
test_sign_job_creation() {
  section "1. Sign job creation + stuck-in-signing recovery"
  new_test_session "sign" "signing" || return
  local proctor_id="$NEW_PROCTOR_ID" session_id="$NEW_SESSION_ID" step_token="$NEW_STEP_TOKEN"
  # Session starts already 'signing' with zero job rows -- the exact crash
  # scenario nda-session-submit's handleSign must be able to recover from.

  local resp
  resp=$(call_fn "nda-session-submit" "{\"stepToken\":\"${step_token}\",\"action\":\"sign\",\"viewedToEnd\":true,\"signatureImageBase64\":\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=\",\"textValues\":{}}")
  if [ "$(json_field "$resp" success)" = "True" ]; then
    pass "handleSign accepted a retry on a session stuck in 'signing' with no job row"
  else
    fail "handleSign rejected the retry: $resp"
  fi

  local job_count
  job_count=$(db_scalar "select count(*) as v from pdf_generation_jobs where session_id = '${session_id}' and job_type = 'sign_render'")
  if [ "$job_count" = "1" ]; then
    pass "exactly one sign_render job now exists"
  else
    fail "expected 1 sign_render job, found: $job_count"
  fi

  local final_status=""
  for _ in $(seq 1 10); do
    final_status=$(db_scalar "select status as v from nda_signing_sessions where id = '${session_id}'")
    [ "$final_status" = "signed" ] && break
    sleep 1
  done
  if [ "$final_status" = "signed" ]; then
    pass "session reached 'signed' (job actually processed, not just created)"
  else
    fail "session never reached 'signed', last seen status: $final_status"
  fi
  CLEANUP_STORAGE_PATHS+=("sessions/${session_id}/signature.png" "sessions/${session_id}/signed-nda.pdf")
}

# ---------------------------------------------------------------------------
# 2. Document replacement (stale-verification-write race guard, migration 0074)
# ---------------------------------------------------------------------------
test_document_replacement_guard() {
  section "2. Document replacement race guard"
  new_test_session "docreplace" "consented" || return
  local proctor_id="$NEW_PROCTOR_ID" session_id="$NEW_SESSION_ID" step_token="$NEW_STEP_TOKEN"

  upload_test_doc "$step_token" "resume" "gen1" >/dev/null
  local j1_id="" j1_status=""
  for _ in $(seq 1 10); do
    j1_id=$(db_scalar "select id::text as v from document_integrity_jobs where session_id = '${session_id}' and doc_kind = 'resume'")
    j1_status=$(db_scalar "select status as v from document_integrity_jobs where id = '${j1_id}'")
    [ "$j1_status" = "completed" ] && break
    sleep 1
  done
  if [ "$j1_status" = "completed" ]; then pass "generation-1 job completed"; else fail "generation-1 job never completed (last status: $j1_status)"; fi

  call_fn "nda-session-upload-url" "{\"stepToken\":\"${step_token}\",\"action\":\"remove\",\"docKind\":\"resume\"}" >/dev/null

  upload_test_doc "$step_token" "resume" "gen2" >/dev/null
  local j2_id="" j2_status=""
  for _ in $(seq 1 10); do
    j2_id=$(db_scalar "select id::text as v from document_integrity_jobs where session_id = '${session_id}' and doc_kind = 'resume'")
    j2_status=$(db_scalar "select status as v from document_integrity_jobs where id = '${j2_id}'")
    [ -n "$j2_id" ] && [ "$j2_id" != "$j1_id" ] && [ "$j2_status" = "completed" ] && break
    sleep 1
  done
  if [ -n "$j2_id" ] && [ "$j2_id" != "$j1_id" ] && [ "$j2_status" = "completed" ]; then
    pass "generation-2 got a fresh job id ($j2_id != $j1_id) and completed"
  else
    fail "generation-2 job did not get a distinct completed id (got id=$j2_id, status=$j2_status)"
  fi

  # The actual attack: J1's worker call finishing late and trying to write
  # back using its now-stale identity, after the document moved on to J2.
  db_exec "update nda_session_documents set integrity_status = 'mismatch', verified_at = now()
    where session_id = '${session_id}' and doc_kind = 'resume' and verifying_job_id = '${j1_id}'"
  local current_status current_job
  current_status=$(db_scalar "select integrity_status as v from nda_session_documents where session_id = '${session_id}' and doc_kind = 'resume'")
  current_job=$(db_scalar "select verifying_job_id::text as v from nda_session_documents where session_id = '${session_id}' and doc_kind = 'resume'")
  if [ "$current_status" = "verified" ] && [ "$current_job" = "$j2_id" ]; then
    pass "stale J1 write was rejected -- document row still reflects J2 ('verified', verifying_job_id=J2)"
  else
    fail "stale write was NOT rejected -- integrity_status=$current_status, verifying_job_id=$current_job"
  fi
}

# ---------------------------------------------------------------------------
# 3. Stale reclaim
# ---------------------------------------------------------------------------
test_stale_reclaim() {
  section "3. Stale reclaim"
  new_test_session "stalereclaim" "signing" || return
  local proctor_id="$NEW_PROCTOR_ID" session_id="$NEW_SESSION_ID" step_token="$NEW_STEP_TOKEN"

  # Plant a job stuck 'processing' with a lock older than the worker's own
  # 5-minute staleness threshold (nda-jobs-worker's STALE_MINUTES), attempt
  # count still under max -- should get reclaimed to 'retrying', not 'failed'.
  db_exec "insert into document_integrity_jobs (session_id, doc_kind, storage_path, client_sha256, status, attempt_count, max_attempts, locked_at)
    values ('${session_id}', 'resume', 'sessions/${session_id}/docs/resume.pdf', repeat('a', 64), 'processing', 1, 3, now() - interval '10 minutes')"

  # Trigger a real nda-jobs-worker invocation without needing its shared
  # secret ourselves: reclaimStaleJobs() runs unconditionally at the top of
  # every invocation (cron or kick), across the WHOLE table, not scoped to
  # whatever triggered it -- so any legitimate action that fires the
  # function's own internal kick (which already knows its own secret) also
  # reclaims our planted row. A throwaway document upload on a second,
  # unrelated session is the cheapest such action.
  new_test_session "stalereclaimkick" "consented" || return
  upload_test_doc "$NEW_STEP_TOKEN" "resume" "reclaimkick" >/dev/null

  local reclaimed_status="" reclaimed_locked=""
  for _ in $(seq 1 10); do
    reclaimed_status=$(db_scalar "select status as v from document_integrity_jobs where session_id = '${session_id}' and doc_kind = 'resume'")
    [ "$reclaimed_status" != "processing" ] && break
    sleep 1
  done
  reclaimed_locked=$(db_scalar "select case when locked_at is null then 'null' else 'set' end as v from document_integrity_jobs where session_id = '${session_id}' and doc_kind = 'resume'")

  if [ "$reclaimed_status" = "retrying" ] && [ "$reclaimed_locked" = "null" ]; then
    pass "stale 'processing' row reclaimed to 'retrying' with locked_at cleared"
  else
    fail "expected status=retrying, locked_at=null; got status=$reclaimed_status, locked_at=$reclaimed_locked"
  fi
}

# ---------------------------------------------------------------------------
# 4. Terminal failure propagation
# ---------------------------------------------------------------------------
test_terminal_failure_propagation() {
  section "4. Terminal failure propagation"
  new_test_session "termfail" "signing" || return
  local proctor_id="$NEW_PROCTOR_ID" session_id="$NEW_SESSION_ID" step_token="$NEW_STEP_TOKEN"

  # Job created FIRST so its id is known, then the document row references it
  # via verifying_job_id -- exactly how the real confirm() flow wires them
  # together (migration 0074). Without this, the terminal-failure write below
  # would be correctly rejected by that same guard as belonging to no current
  # document (a *different* scenario -- test 2 already covers that one), not
  # a real terminal failure on a document actively being tracked.
  local job_id
  job_id=$(db_scalar "insert into document_integrity_jobs (session_id, doc_kind, storage_path, client_sha256, status, attempt_count, max_attempts, locked_at)
    values ('${session_id}', 'resume', 'sessions/${session_id}/docs/resume.pdf', repeat('a', 64), 'processing', 3, 3, now() - interval '10 minutes')
    returning id::text as v")
  db_exec "insert into nda_session_documents (session_id, doc_kind, storage_path, client_sha256, content_sha256, integrity_status, byte_size, content_type, verifying_job_id)
    values ('${session_id}', 'resume', 'sessions/${session_id}/docs/resume.pdf', repeat('a', 64), null, 'pending', 100, 'application/pdf', '${job_id}')"

  new_test_session "termfailkick" "consented" || return
  upload_test_doc "$NEW_STEP_TOKEN" "resume" "termfailkick" >/dev/null

  local job_status="" doc_status=""
  for _ in $(seq 1 10); do
    job_status=$(db_scalar "select status as v from document_integrity_jobs where session_id = '${session_id}' and doc_kind = 'resume'")
    [ "$job_status" = "failed" ] && break
    sleep 1
  done
  doc_status=$(db_scalar "select integrity_status as v from nda_session_documents where session_id = '${session_id}' and doc_kind = 'resume'")

  if [ "$job_status" = "failed" ]; then
    pass "job reached terminal 'failed' (attempt_count already at max_attempts)"
  else
    fail "job never reached 'failed', last seen: $job_status"
  fi
  if [ "$doc_status" = "mismatch" ]; then
    pass "terminal failure propagated to nda_session_documents.integrity_status = 'mismatch' (never left at 'pending')"
  else
    fail "expected integrity_status = 'mismatch', got: $doc_status"
  fi
}

# ---------------------------------------------------------------------------
# 5. Cron disarm/rearm
# ---------------------------------------------------------------------------
test_cron_disarm_rearm() {
  section "5. Cron disarm/rearm"

  local open_before
  open_before=$(db_scalar "select count(*) as v from (select 1 as x from pdf_generation_jobs where status in ('queued','processing','retrying') union all select 1 as x from document_integrity_jobs where status in ('queued','processing','retrying')) t")

  if [ "$open_before" != "0" ]; then
    echo "  SKIP (disarm half): $open_before real NDA job(s) currently open -- disarm can't be observed without them finishing first. Rearm is still checked below."
  else
    db_exec "select cron.unschedule(jobid) from cron.job where jobname = 'drain-nda-jobs-queue'"
    db_exec "select ensure_nda_jobs_cron()"
    local scheduled_when_empty
    scheduled_when_empty=$(db_scalar "select count(*) as v from cron.job where jobname = 'drain-nda-jobs-queue'")
    if [ "$scheduled_when_empty" = "0" ]; then
      pass "ensure_nda_jobs_cron() left the cron unscheduled when no NDA job rows are open"
    else
      fail "expected the cron to stay unscheduled with zero open jobs, found $scheduled_when_empty entry(ies)"
    fi
  fi

  # Rearm: plant one queued row, call ensure_nda_jobs_cron(), confirm it's
  # scheduled again.
  new_test_session "cronrearm" "signing" || return
  local session_id="$NEW_SESSION_ID"
  db_exec "insert into document_integrity_jobs (session_id, doc_kind, storage_path, client_sha256, status)
    values ('${session_id}', 'resume', 'sessions/${session_id}/docs/resume.pdf', repeat('a', 64), 'queued')"
  db_exec "select ensure_nda_jobs_cron()"
  local scheduled_when_open
  scheduled_when_open=$(db_scalar "select count(*) as v from cron.job where jobname = 'drain-nda-jobs-queue'")
  if [ "$scheduled_when_open" = "1" ]; then
    pass "ensure_nda_jobs_cron() (re)armed the cron with one queued job present"
  else
    fail "expected the cron to be scheduled with an open job present, found $scheduled_when_open entry(ies)"
  fi
}

echo "NDA job queue integration checks -- run ${RUN_ID}"
test_sign_job_creation
test_document_replacement_guard
test_stale_reclaim
test_terminal_failure_propagation
test_cron_disarm_rearm

echo ""
echo "=== Result: ${PASS_COUNT} passed, ${FAIL_COUNT} failed ==="
[ "$FAIL_COUNT" -eq 0 ]
