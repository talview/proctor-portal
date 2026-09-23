-- sign_render now runs inside nda-jobs-worker, decoupled from the signer's original
-- HTTP request -- the worker has no Request object of its own, so the
-- 'signed_pdf_generated' event it logs was always getting ip_address/user_agent:null
-- (surfacing as "IP: unknown" in the audit certificate's Document History, even
-- though the VIEWED event right before it has a real IP). Captured instead at sign
-- time in nda-session-submit's handleSign, which still runs synchronously inside the
-- signer's real request, and threaded through the job row to the worker.
ALTER TABLE pdf_generation_jobs ADD COLUMN signer_ip text;
ALTER TABLE pdf_generation_jobs ADD COLUMN signer_user_agent text;
