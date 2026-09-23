-- requireStepToken (nda.ts) -- called on every single step of NDA signing (view,
-- consent, each document upload, submit) -- looks sessions up by step_token_sha256.
-- No index existed at all (only session_token_sha256, the *initial* email-link token,
-- was indexed), so every one of those calls sequentially scans the whole
-- nda_signing_sessions table. Invisible today at a handful of rows; real once many
-- candidates are signing concurrently, since every action any of them takes hits this
-- same lookup.
create index idx_nda_signing_sessions_step_token on nda_signing_sessions (step_token_sha256);
