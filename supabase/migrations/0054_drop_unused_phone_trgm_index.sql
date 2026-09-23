-- ProctorsPage/OffboardedPage no longer search by phone (name/email/pid cover what's
-- actually needed) -- idx_proctors_phone_trgm (added in 0053 specifically for phone
-- substring search) has no remaining purpose and is dropped rather than left as dead
-- index-maintenance weight on every proctor write. The pre-existing idx_proctors_phone
-- (plain btree, backing the uniq_phone_active constraint) is untouched -- unrelated to
-- search.
drop index if exists idx_proctors_phone_trgm;
