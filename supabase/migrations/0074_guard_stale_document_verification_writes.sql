-- Closes a real race: verification writes to nda_session_documents were keyed
-- only on (session_id, doc_kind), with no guard against a stale in-flight job.
-- A candidate can remove() a document (which deletes its document_integrity_jobs
-- row outright, not resets it) and confirm() a replacement while the OLD job's
-- worker call is still mid-flight (claimed, then downloading/hashing). Because
-- the upload path is deterministic per (session, doc_kind, extension)
-- (sessions/{id}/docs/{docKind}.{ext} -- see nda-session-upload-url's `request`
-- action), a same-extension replacement reuses the *identical* storage_path, so
-- guarding on storage_path alone (as first proposed) would not catch the common
-- case. The document_integrity_jobs row's own id IS reliably fresh on every
-- replacement though: remove() deletes it, so the next confirm() always INSERTs
-- a brand-new row (a fresh id from gen_random_uuid()), never an in-place UPDATE.
-- Tying every verification write to that id closes the race regardless of
-- whether the path or hash happens to match the prior generation.
alter table nda_session_documents
  add column verifying_job_id uuid references document_integrity_jobs(id) on delete set null;
