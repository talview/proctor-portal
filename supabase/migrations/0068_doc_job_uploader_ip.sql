-- Same gap as migration 0067, one layer over: verifyDocumentIntegrity also runs
-- inside nda-jobs-worker, decoupled from the uploader's original request, so the
-- 'document_verified'/'document_integrity_mismatch' events it logs always got
-- ip_address/user_agent:null -- surfacing as "from unknown (unknown)" in the
-- certificate.pdf event log for every single document. Captured instead at confirm
-- time in nda-session-upload-url (still runs synchronously inside the uploader's
-- real request) and threaded through the job row to the worker.
ALTER TABLE document_integrity_jobs ADD COLUMN uploader_ip text;
ALTER TABLE document_integrity_jobs ADD COLUMN uploader_user_agent text;
