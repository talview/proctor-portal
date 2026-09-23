-- delete_interview_select (migration 0021) hard-deletes a proctors row, but the FK
-- from bulk_dispatch_items to proctors had no ON DELETE clause (defaults to NO
-- ACTION/RESTRICT) -- so any candidate who was ever part of a single bulk send
-- became permanently undeletable ("violates foreign key constraint
-- bulk_dispatch_items_proctor_id_fkey"), even one still sitting at 'interview_selected'
-- with an Expired, never-submitted form. Since the RPC only ever allows deleting a row
-- that hasn't progressed past Interview Selects, that candidate's dispatch history is
-- only ever about a send/resend that no longer has anyone to reach -- CASCADE removes
-- it along with the proctor row it belonged to, matching the RPC's existing "hard
-- delete, no trace left" design rather than half-deleting and leaving orphaned rows.
alter table bulk_dispatch_items
  drop constraint bulk_dispatch_items_proctor_id_fkey,
  add constraint bulk_dispatch_items_proctor_id_fkey
    foreign key (proctor_id) references proctors(id) on delete cascade;
