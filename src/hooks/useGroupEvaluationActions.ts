import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { logAudit } from '@/services/audit';
import { showAlert } from '@/components/ui/GlobalDialog';
import { runWithConcurrency } from '@/utils/concurrency';
import { downloadBlob } from '@/lib/download';
import { buildGroupEvaluationWorkbook, parseGroupEvaluationWorkbook } from '@/utils/assessmentGroupXlsx';
import type { Evaluation, Proctor } from '@/types';

/**
 * Download/upload behavior for a Group Assessment session (a Multi Assign batch --
 * every member shares one group_id, see EvaluationsPage's BulkAssessment). Shared by
 * every place a group can be opened (Workspace's Upcoming Tasks and Scheduled Events
 * tabs) so both behave identically -- one implementation, not two that can drift.
 */
export function useGroupEvaluationActions(items: Evaluation[], proctors: Proctor[]) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const first = items[0];

  const handleDownload = async () => {
    setBusy(true);
    try {
      const rows = items.map((task) => {
        const proctor = proctors.find((p) => p.id === task.proctor_id);
        return {
          evaluationId: task.id,
          proctorName: proctor?.name || 'Unknown',
          proctorEmail: proctor?.email || '',
          vendor: proctor?.vendor || proctor?.managed_by || '',
          ptype: proctor?.ptype || '',
          attemptNumber: task.attempt_number,
          result: task.result || null,
          comment: task.comment || null,
          scoreObtained: task.score_obtained ?? null,
          candidateId: task.candidate_id || null,
          sectionId: task.section_id || null,
        };
      });
      const blob = await buildGroupEvaluationWorkbook(
        {
          panelUser: first.panel_user,
          scheduledDate: first.scheduled_date,
          scheduledTime: first.scheduled_time || null,
          scoreOutOf: first.score_out_of ?? null,
        },
        rows
      );
      downloadBlob(`group_assessment_${first.scheduled_date}_${(first.group_id || first.id).slice(0, 8)}.xlsx`, blob);
    } catch (err: any) {
      showAlert('Failed to build the evaluation sheet: ' + err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { setBusy(false); return; }
    setBusy(true);
    try {
      const parsedRows = await parseGroupEvaluationWorkbook(file);
      const byId = new Map(items.map((t) => [t.id, t]));

      // A group session can easily outlive one sitting -- e.g. 40 candidates scheduled
      // together, but only 20 actually get a result today, the rest coming back on a
      // later re-download/re-upload once they're evaluated. So two kinds of rows in the
      // uploaded file are expected and NOT failures, just silently excluded from this
      // submission pass:
      //  - already recorded (a second submission is an override, which
      //    submit_evaluation_result deliberately reserves to admins)
      //  - not yet filled in (still blank Result -- simply not done yet)
      // Only genuinely wrong input (a filled-in row missing a required field) should
      // count as a failure.
      let alreadyRecorded = 0;
      let notYetFilled = 0;
      const toSubmit = parsedRows.filter((row) => {
        const task = byId.get(row.evaluationId);
        if (!task) return false;
        if (task.result) { alreadyRecorded++; return false; }
        if (!row.result) { notYetFilled++; return false; }
        return true;
      });

      const results = await runWithConcurrency(toSubmit, 4, async (row) => {
        const task = byId.get(row.evaluationId)!;

        const { error } = await supabase.rpc('submit_evaluation_result', {
          p_evaluation_id: row.evaluationId,
          p_result: row.result,
          p_score: row.scoreObtained ?? 0,
          p_comment: row.comment || '',
          p_session_code: null,
          p_candidate_id: row.candidateId || null,
          p_section_id: row.sectionId || null,
        });
        if (error) throw error;

        const proctor = proctors.find((p) => p.id === task.proctor_id);
        await logAudit({
          action: 'Eval Result',
          target: proctor?.name || task.proctor_id,
          detail: `${task.eval_type} Attempt #${task.attempt_number}: ${row.result}${row.comment ? ` — ${row.comment}` : ''} · via group upload · by ${user?.username || user?.name || 'system'}`,
          user: user?.username || user?.name || null,
        });
      });

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      await queryClient.invalidateQueries({ queryKey: ['workspace-tasks'] });
      await queryClient.invalidateQueries({ queryKey: ['scheduled-events'] });
      await queryClient.invalidateQueries({ queryKey: ['evaluations-results'] });

      const parts = [`${succeeded} saved`];
      if (notYetFilled > 0) parts.push(`${notYetFilled} not yet filled in`);
      if (alreadyRecorded > 0) parts.push(`${alreadyRecorded} already recorded`);
      if (failed.length > 0) parts.push(`${failed.length} failed (e.g. ${failed[0].reason?.message || 'unknown error'})`);
      const tone = failed.length === 0 ? 'success' : succeeded > 0 ? 'info' : 'error';
      showAlert(parts.join(', '), { tone });
    } catch (err: any) {
      showAlert('Failed to process the uploaded file: ' + err.message, { tone: 'error' });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return { busy, handleDownload, handleUpload };
}
