-- Baseline schema: the 11 core tables that predate this project's migration history
-- (created directly via the Supabase SQL editor before migrations were adopted) --
-- app_config, audit_log, customers, final_onboarding_forms, proctor_certifications,
-- proctor_evaluations, proctors, user_notes, users, vendor_contacts, vendors.
-- Every other table in the live schema (bulk_dispatch_*, nda_*, app_secrets) is
-- already created by a tracked migration further down this same folder.
--
-- Reconstructed, not dumped: this is each table's shape as of just BEFORE migration
-- 0001 ran, not today's live shape -- every column/constraint/index a later tracked
-- migration adds, drops, renames, or retypes is deliberately left out (or left in its
-- pre-change form) here, so that replaying 0001 through the rest of this folder in
-- order reproduces the live schema exactly. In particular:
--   - proctors.id has no default yet (added by 0008); dob is free-text with no
--     18+ check yet (0055 converts the type and adds the check); demo_eval_link,
--     assessment_link, and form_otp exist and are later dropped (0033, 0033, 0031);
--     nda_link_expires_at, form_otp_hash/form_otp_failed_lifetime/form_otp_send_count,
--     and nda_viewed_at don't exist yet (0026, 0031, 0048 add them); vendor and
--     managed_by are two separate columns here -- 0056 later drops the original
--     `vendor`, then renames `managed_by` to `vendor`.
--   - idx_proctors_vendor doesn't exist yet either: 0053 creates it as
--     idx_proctors_managed_by, and 0056 renames it in the same step as the column
--     rename above.
--   - users has no vendor_id column yet (0001 adds it, inline FK included); user_notes
--     has no user_id column yet (0003 adds it, inline FK included) and username is
--     still NOT NULL (0019 relaxes it); proctor_certifications has no customer_name
--     (0018) or candidate_id/section_id/result_url (0023) yet; proctor_evaluations has
--     no session_code/candidate_id/section_id/result_url yet (0023); audit_log has no
--     ref_id yet (0036).
--   - No RLS policies, and only the handful of indexes/constraints below: every
--     policy (all of them) and most indexes are created by tracked migrations
--     starting at 0002/0003, which this baseline leaves for them to do untouched.
--     PRIMARY KEY/UNIQUE/FOREIGN KEY constraints below are exactly the ones no
--     tracked migration ever creates (directly or via an inline ADD COLUMN ...
--     REFERENCES), so nothing here collides with anything replayed after it.

CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  ts timestamp with time zone DEFAULT now(),
  usr text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS vendors (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  contact_name text DEFAULT ''::text,
  contact_email text DEFAULT ''::text,
  contact_phone text DEFAULT ''::text,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  created_by text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS vendor_contacts (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE,
  name text DEFAULT ''::text NOT NULL,
  email text DEFAULT ''::text,
  phone text DEFAULT ''::text,
  role text DEFAULT ''::text,
  is_primary boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password text NOT NULL,
  role text NOT NULL,
  vendor text,
  created_at timestamp with time zone DEFAULT now(),
  email text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS user_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  username text NOT NULL,
  title text NOT NULL,
  body text,
  colour text DEFAULT 'yellow'::text,
  due_date date,
  done boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  name text NOT NULL UNIQUE,
  current_version integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  created_by text DEFAULT ''::text,
  session_type text[] DEFAULT '{}'::text[],
  fd_rate numeric DEFAULT 0,
  hd_rate numeric DEFAULT 0,
  org_id text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS proctors (
  id text NOT NULL PRIMARY KEY,
  pid text DEFAULT ''::text,
  name text NOT NULL,
  aadhaar text NOT NULL,
  phone text NOT NULL,
  email text DEFAULT ''::text,
  address text DEFAULT ''::text,
  city text DEFAULT ''::text,
  state text DEFAULT ''::text,
  dob text DEFAULT ''::text,
  gender text DEFAULT ''::text,
  ptype text DEFAULT ''::text,
  bgv text DEFAULT ''::text,
  nda text DEFAULT ''::text,
  notes text DEFAULT ''::text,
  status text DEFAULT 'In Progress'::text NOT NULL,
  stage integer DEFAULT 1,
  by_user text DEFAULT ''::text,
  at timestamp with time zone DEFAULT now(),
  upd timestamp with time zone DEFAULT now(),
  vby text DEFAULT ''::text,
  vat timestamp with time zone,
  aat timestamp with time zone,
  oat timestamp with time zone,
  off_reason text DEFAULT ''::text,
  off_notes text DEFAULT ''::text,
  notified boolean DEFAULT false,
  nda_status text DEFAULT ''::text,
  nda_triggered_at timestamp with time zone,
  nda_triggered_by text DEFAULT ''::text,
  nda_signed_at timestamp with time zone,
  nda_file_url text DEFAULT ''::text,
  demo_ready text DEFAULT 'awaiting'::text,
  assessment_ready text DEFAULT 'awaiting'::text,
  demo_eval text DEFAULT 'Pending'::text,
  assessment text DEFAULT 'Pending'::text,
  demo_ready_attempt integer DEFAULT 1,
  assessment_ready_attempt integer DEFAULT 1,
  interview_stage text DEFAULT ''::text,
  form_link_token text DEFAULT ''::text,
  form_status text DEFAULT ''::text,
  form_shared_at timestamp with time zone,
  form_submitted_at timestamp with time zone,
  vendor text DEFAULT ''::text,
  managed_by text DEFAULT ''::text,
  vendor_verified boolean DEFAULT false,
  vendor_verified_by text DEFAULT ''::text,
  vendor_verified_at timestamp with time zone,
  final_form_status text DEFAULT ''::text,
  doc_resume text DEFAULT ''::text,
  doc_passport_photo text DEFAULT ''::text,
  doc_grad_cert text DEFAULT ''::text,
  doc_aadhaar_copy text DEFAULT ''::text,
  doc_pan_copy text DEFAULT ''::text,
  doc_eye_test text DEFAULT ''::text,
  form_link_sent_at timestamp with time zone,
  form_link_expires_at timestamp with time zone,
  form_otp text,
  form_otp_expires_at timestamp with time zone,
  form_otp_attempts integer DEFAULT 0,
  form_access_count integer DEFAULT 0,
  form_submit_token text,
  form_submit_token_expires_at timestamp with time zone,
  demo_eval_link text DEFAULT ''::text,
  assessment_link text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS final_onboarding_forms (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  proctor_id text NOT NULL,
  token text NOT NULL UNIQUE,
  status text DEFAULT 'sent'::text,
  submitted_at timestamp with time zone,
  doc_resume text DEFAULT ''::text,
  doc_passport_photo text DEFAULT ''::text,
  doc_grad_cert text DEFAULT ''::text,
  doc_aadhaar_copy text DEFAULT ''::text,
  doc_pan_copy text DEFAULT ''::text,
  doc_eye_test text DEFAULT ''::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proctor_evaluations (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  proctor_id text NOT NULL,
  eval_type text NOT NULL,
  panel_user text NOT NULL,
  scheduled_date date,
  conducted_date date,
  result text,
  attempt_number integer DEFAULT 1,
  comment text,
  created_at timestamp with time zone DEFAULT now(),
  created_by text,
  status text DEFAULT 'scheduled'::text,
  certified_date date,
  score_obtained numeric,
  score_out_of numeric,
  scheduled_time text DEFAULT ''::text,
  overridden_by text DEFAULT ''::text,
  overridden_at timestamp with time zone,
  group_id text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS proctor_certifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  proctor_id text,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  status text DEFAULT 'Certified'::text,
  version_certified integer DEFAULT 1,
  certified_date date DEFAULT CURRENT_DATE,
  assessment_link text DEFAULT ''::text,
  certified_by text DEFAULT ''::text,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE (proctor_id, customer_id)
);

-- Legacy pre-Supabase-Auth login check -- superseded by native Supabase Auth before
-- migration tracking began, kept only so 0003's REVOKE EXECUTE (retiring it) has a
-- real function to act on. Never called by any tracked migration or app code.
CREATE OR REPLACE FUNCTION verify_login(p_username text, p_password text)
RETURNS SETOF users
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM users WHERE username = p_username AND password = p_password;
$$;

-- Only the indexes/constraints no tracked migration ever creates or renames into
-- existence -- see the file header for the ones deliberately left for later files.
CREATE INDEX idx_audit_ts ON audit_log USING btree (ts DESC);
CREATE INDEX idx_proctors_aadhaar ON proctors USING btree (aadhaar);
CREATE INDEX idx_proctors_email ON proctors USING btree (lower(email));
CREATE INDEX idx_proctors_form_link_token ON proctors USING btree (form_link_token) WHERE (form_link_token IS NOT NULL);
CREATE INDEX idx_proctors_phone ON proctors USING btree (phone);
CREATE INDEX idx_proctors_status ON proctors USING btree (status);
CREATE UNIQUE INDEX uniq_email_active ON proctors USING btree (lower(email)) WHERE ((status <> 'Archived'::text) AND (email <> ''::text));
CREATE UNIQUE INDEX uniq_aadhaar_active ON proctors USING btree (aadhaar) WHERE (status <> 'Archived'::text);
CREATE UNIQUE INDEX uniq_phone_active ON proctors USING btree (phone) WHERE (status <> 'Archived'::text);

-- All 10 of these tables were also enabled for Realtime (via the dashboard, never a
-- migration) before this project's migration history begins -- 0045/0046/0050 later
-- drop/restore/drop this same membership, ending with none of them published. The
-- `supabase_realtime` publication itself is created automatically by the Supabase
-- platform on every project, not by user migrations or this file.
ALTER PUBLICATION supabase_realtime ADD TABLE
  proctors,
  audit_log,
  users,
  customers,
  proctor_certifications,
  proctor_evaluations,
  user_notes,
  vendors,
  final_onboarding_forms,
  vendor_contacts;
