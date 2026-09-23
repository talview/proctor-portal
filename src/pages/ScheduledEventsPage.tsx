import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Lock, Save, Upload } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import { logAudit } from '@/services/audit';
import { EVAL_REASON_OPTIONS_BY_RESULT } from '@/utils/constants';
import { showAlert } from '@/components/ui/GlobalDialog';
import { useAllProctorsLookup } from '@/hooks/useAllProctorsLookup';
import { useGroupEvaluationActions } from '@/hooks/useGroupEvaluationActions';
import { ScheduleBoard } from '@/components/schedule/ScheduleBoard';
import type { Evaluation, ScheduledEventFilters } from '@/types';

/** Evaluating demo/assessment sessions -- split out from Workspace, which is now a
 * pure reminder space (schedule glance + personal notes, no scoring actions). This
 * page is where the actual "Evaluate" workflow lives: the same day-grouped
 * ScheduleBoard, but with evaluate wired up, plus the result/group-upload modals
 * that workflow opens. */
export default function ScheduledEventsPage() {
  const [evaluationToReview, setEvaluationToReview] = useState<any | null>(null);
  const [groupToEvaluate, setGroupToEvaluate] = useState<Evaluation[] | null>(null);
  // Workspace's Upcoming Tasks cards ("12 pending demos from 12 Sep") navigate here
  // with a pre-set date/type via router state, so clicking one actually lands on the
  // relevant items instead of the bare, unfiltered board.
  const location = useLocation();
  const initialFilters = (location.state as { filters?: Partial<ScheduledEventFilters> } | null)?.filters;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-[20px] font-bold text-text">Scheduled Events</h2>
        <p className="text-[13px] text-text2 mt-0.5">Evaluate demo and assessment sessions as they come up</p>
      </div>

      <ScheduleBoard
        initialFilters={initialFilters}
        onEvaluate={(task) => setEvaluationToReview(task)}
        onEvaluateGroup={(items) => setGroupToEvaluate(items)}
      />

      {evaluationToReview && (
        <EvaluationResultModal
          evaluation={evaluationToReview}
          onClose={() => setEvaluationToReview(null)}
          onSuccess={() => setEvaluationToReview(null)}
        />
      )}

      {groupToEvaluate && (
        <GroupEvaluationModal
          items={groupToEvaluate}
          onClose={() => setGroupToEvaluate(null)}
        />
      )}
    </div>
  );
}

/** What "Evaluate" opens for a Group Assessment session -- the candidate list plus
 * the Download/Upload actions. */
function GroupEvaluationModal({
  items,
  onClose,
}: {
  items: Evaluation[];
  onClose: () => void;
}) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const { data: proctors = [] } = useAllProctorsLookup();
  // A local, updatable copy of `items` -- `items` itself is a snapshot from the moment
  // this modal opened, so without this the "Pending" badges below would never reflect
  // a just-completed upload even though it saved successfully (see useGroupEvaluationActions).
  const [localItems, setLocalItems] = useState(items);
  const { busy, handleDownload, handleUpload } = useGroupEvaluationActions(localItems, proctors, setLocalItems);
  const first = localItems[0];
  const canEvaluate = canEvaluateNow(first.scheduled_date, first.scheduled_time);

  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Modal isOpen={true} onClose={onClose} title={`Group Assessment · ${localItems.length} candidates`}>
      <div className="space-y-4">
        <div className="text-[12px] text-text3">
          <span className="text-accent">Panel: {first.panel_user}</span>
          {' · '}{formatDate(first.scheduled_date)}
          {first.scheduled_time && ` · ${first.scheduled_time}`}
          {first.score_out_of ? ` · Score out of: ${first.score_out_of}` : ''}
        </div>

        <div className="rounded-md border border-border divide-y divide-border overflow-hidden max-h-80 overflow-y-auto">
          {localItems.map((task) => {
            const proctor = proctors.find((p) => p.id === task.proctor_id);
            return (
              <div key={task.id} className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface2/40">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-text truncate">{proctor?.name || 'Unknown'}</div>
                  <div className="text-[10px] text-text3">
                    {proctor?.vendor && `${proctor?.vendor} · `}
                    {proctor?.ptype} · Attempt #{task.attempt_number}
                  </div>
                </div>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${task.result ? 'bg-success/10 text-success' : 'bg-surface text-text3'}`}>
                  {task.result || 'Pending'}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={handleDownload} disabled={busy}>
            <Download className="w-3.5 h-3.5" /> Download Evaluation Sheet
          </Button>
          {canEvaluate ? (
            <>
              <Button variant="primary" size="sm" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
                <Upload className="w-3.5 h-3.5" /> {busy ? 'Processing…' : 'Upload Completed Sheet'}
              </Button>
              <input ref={uploadInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleUpload} />
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled
              title={`Unlocks 30min before: ${formatDate(first.scheduled_date)}${first.scheduled_time ? ' ' + first.scheduled_time : ''}`}
            >
              <Lock className="w-3.5 h-3.5" /> Locked
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Duplicated intentionally rather than imported from ScheduleBoard -- this is a
// tiny, self-contained predicate and the two modules should stay independently
// movable without a shared-internals import between a page and its board.
function canEvaluateNow(scheduledDate: string, scheduledTime?: string): boolean {
  const now = new Date();
  const schedDate = new Date(scheduledDate);
  if (scheduledTime) {
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    schedDate.setHours(hours, minutes, 0, 0);
    const unlockTime = new Date(schedDate.getTime() - 30 * 60 * 1000);
    return now >= unlockTime;
  }
  return now >= schedDate;
}

function formatDateTime(date?: string, time?: string) {
  if (!date) return '—';
  const d = new Date(date);
  const dateStr = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  return time ? `${dateStr} ${time}` : dateStr;
}

function EvaluationResultModal({
  evaluation,
  onClose,
  onSuccess,
}: {
  evaluation: any;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState(evaluation.result || '');
  const [score, setScore] = useState(
    evaluation.score_obtained != null ? String(evaluation.score_obtained) : ''
  );
  const [comment, setComment] = useState(evaluation.comment || '');
  const [commentOther, setCommentOther] = useState('');
  const [sessionCode, setSessionCode] = useState(evaluation.session_code || '');
  const [candidateId, setCandidateId] = useState(evaluation.candidate_id || '');
  const [sectionId, setSectionId] = useState(evaluation.section_id || '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const needsEvidence = result && result !== 'No Show';
  const previewUrl =
    !needsEvidence ? '' :
    evaluation.eval_type === 'demo'
      ? (sessionCode ? `https://recruit.talview.com/recruiter/live-session/${sessionCode}` : '')
      : (candidateId && sectionId ? `https://recruit.talview.com/recruiter/invites/${candidateId}/assessment-section/${sectionId}/answers` : '');

  const { data: proctor } = useQuery({
    queryKey: ['workspace-eval-proctor', evaluation.proctor_id],
    queryFn: async () => {
      if (evaluation.proctor) return evaluation.proctor;
      const { data, error } = await supabase
        .from('proctors')
        .select('id, name, vendor, email')
        .eq('id', evaluation.proctor_id)
        .single();

      if (error) throw error;
      return data;
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const newErrors: Record<string, string> = {};

      if (!result) newErrors.result = 'Result is required';
      if (!score || isNaN(Number(score))) newErrors.score = 'Score is required';
      else if (Number(score) < 0) newErrors.score = 'Score cannot be negative';
      else if (evaluation.score_out_of && Number(score) > evaluation.score_out_of) {
        newErrors.score = `Score cannot exceed ${evaluation.score_out_of}`;
      }
      if (['Reattempt', 'Reschedule'].includes(result) && !comment && !commentOther) {
        newErrors.comment = 'Comment is required for ' + result;
      }
      if (needsEvidence) {
        if (evaluation.eval_type === 'demo') {
          if (!sessionCode.trim()) newErrors.sessionCode = 'Session Code is required';
        } else {
          if (!candidateId.trim()) newErrors.candidateId = 'Candidate ID is required';
          if (!sectionId.trim()) newErrors.sectionId = 'Section ID is required';
        }
      }

      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors);
        throw new Error('Validation failed');
      }

      const finalComment = comment === 'Other' ? commentOther : [comment, commentOther].filter(Boolean).join(' — ');

      const { error: evalError } = await supabase.rpc('submit_evaluation_result', {
        p_evaluation_id: evaluation.id,
        p_result: result,
        p_score: Number(score),
        p_comment: finalComment,
        p_session_code: evaluation.eval_type === 'demo' ? sessionCode.trim() : null,
        p_candidate_id: evaluation.eval_type !== 'demo' ? candidateId.trim() : null,
        p_section_id: evaluation.eval_type !== 'demo' ? sectionId.trim() : null,
      });

      if (evalError) throw evalError;

      const evidenceNote = evaluation.eval_type === 'demo'
        ? (sessionCode ? ` · Session Code: ${sessionCode}` : '')
        : (candidateId || sectionId ? ` · Candidate ID: ${candidateId} · Section ID: ${sectionId}` : '');

      await logAudit({
        action: evaluation.result ? 'Eval Override' : 'Eval Result',
        target: proctor?.name || evaluation.proctor_id,
        detail: `${evaluation.eval_type} Attempt #${evaluation.attempt_number}: ${result}${finalComment ? ` — ${finalComment}` : ''}${evidenceNote}${evaluation.result ? ` [overrides: ${evaluation.result}]` : ''} · by ${useAuthStore.getState().user?.username || useAuthStore.getState().user?.name || 'system'}`,
        user: useAuthStore.getState().user?.username || useAuthStore.getState().user?.name || null,
      });
    },
    onSuccess: async () => {
      // 'workspace-schedule' is the query that actually backs both ScheduleBoard
      // instances (Workspace's reminder view and this page's evaluate view) --
      // invalidating it here means an item just evaluated here also disappears
      // from Workspace's reminder list without a manual reload.
      await queryClient.invalidateQueries({ queryKey: ['workspace-schedule'] });
      await queryClient.invalidateQueries({ queryKey: ['evaluations-results'] });
      onSuccess();
      showAlert('Result saved', { tone: 'success' });
    },
    onError: (error: any) => {
      if (error.message !== 'Validation failed') {
        showAlert('Save failed: ' + error.message, { tone: 'error' });
      }
    },
  });

  const commentOptions = result ? [...(EVAL_REASON_OPTIONS_BY_RESULT[result] || []), 'Other'] : [];

  const finalCommentValue = comment === 'Other' ? commentOther : comment;

  return (
    <Modal isOpen={true} onClose={onClose} title={`${evaluation.result ? 'Override Result' : 'Evaluate'} — ${evaluation.eval_type}`}>
      <div className="space-y-4">
        <div className="text-xs text-text2">
          <div>
            <strong>{proctor?.name || 'Unknown'}</strong> ({proctor?.vendor || '—'}) · {evaluation.eval_type} · Panel: {evaluation.panel_user} · Scheduled: {formatDateTime(evaluation.scheduled_date, evaluation.scheduled_time)} · Attempt #{evaluation.attempt_number}
            {evaluation.score_out_of && ` · Score out of: ${evaluation.score_out_of}`}
          </div>
          {evaluation.result && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-2 mt-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Result already submitted as <strong>{evaluation.result}</strong>. Admin override will be logged.</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-text mb-1">
              Result <span className="text-danger">*</span>
            </label>
            <Select
              options={[
                { value: '', label: 'Select result...' },
                { value: 'Pass', label: 'Pass' },
                { value: 'Reattempt', label: 'Reattempt' },
                { value: 'No Show', label: 'No Show' },
                { value: 'Reschedule', label: 'Reschedule' },
              ]}
              value={result}
              onChange={(e) => {
                setResult(e.target.value);
                setComment('');
                setCommentOther('');
                setErrors({ ...errors, result: '' });
              }}
            />
            {errors.result && <div className="text-danger text-xs mt-1">{errors.result}</div>}
          </div>

          <div>
            <label className="block text-xs font-semibold text-text mb-1">
              Score {evaluation.score_out_of && <span className="text-text3">(out of {evaluation.score_out_of})</span>} <span className="text-danger">*</span>
            </label>
            <Input
              type="number"
              min={0}
              max={evaluation.score_out_of || undefined}
              value={score}
              onChange={(e) => {
                setScore(e.target.value);
                setErrors({ ...errors, score: '' });
              }}
              placeholder="Enter score..."
            />
            {errors.score && <div className="text-danger text-xs mt-1">{errors.score}</div>}
          </div>
        </div>

        {needsEvidence && (
          <div className="bg-surface2 border border-border rounded-lg p-3">
            <div className="text-xs font-semibold text-text mb-2">
              Evidence <span className="text-text3 font-normal normal-case">(builds the result URL automatically)</span>
            </div>
            {evaluation.eval_type === 'demo' ? (
              <div>
                <label className="block text-[11px] font-semibold text-text2 mb-1">
                  Session Code <span className="text-danger">*</span>
                </label>
                <Input
                  placeholder="e.g. abc123"
                  value={sessionCode}
                  onChange={(e) => {
                    setSessionCode(e.target.value);
                    setErrors({ ...errors, sessionCode: '' });
                  }}
                />
                {errors.sessionCode && <div className="text-danger text-xs mt-1">{errors.sessionCode}</div>}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-text2 mb-1">
                    Candidate ID <span className="text-danger">*</span>
                  </label>
                  <Input
                    placeholder="e.g. 12345"
                    value={candidateId}
                    onChange={(e) => {
                      setCandidateId(e.target.value);
                      setErrors({ ...errors, candidateId: '' });
                    }}
                  />
                  {errors.candidateId && <div className="text-danger text-xs mt-1">{errors.candidateId}</div>}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-text2 mb-1">
                    Section ID <span className="text-danger">*</span>
                  </label>
                  <Input
                    placeholder="e.g. 67890"
                    value={sectionId}
                    onChange={(e) => {
                      setSectionId(e.target.value);
                      setErrors({ ...errors, sectionId: '' });
                    }}
                  />
                  {errors.sectionId && <div className="text-danger text-xs mt-1">{errors.sectionId}</div>}
                </div>
              </div>
            )}
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-accent font-semibold hover:underline mt-2 truncate max-w-full"
              >
                {previewUrl}
              </a>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-text mb-1">
            Comment {['Reattempt', 'Reschedule'].includes(result) && <span className="text-danger">*</span>}
          </label>
          <Select
            options={[
              { value: '', label: 'Select reason...' },
              ...commentOptions.map((c) => ({ value: c, label: c })),
            ]}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              setErrors({ ...errors, comment: '' });
            }}
          />
          {comment === 'Other' && (
            <textarea
              value={commentOther}
              onChange={(e) => setCommentOther(e.target.value)}
              placeholder="Enter reason..."
              rows={3}
              className="w-full mt-2 px-3 py-2 bg-surface2 border border-border rounded-lg text-[13px] text-text outline-none focus:border-accent resize-none"
            />
          )}
          {finalCommentValue && (
            <div className="text-[11px] text-text3 mt-1">Selected: {finalCommentValue}</div>
          )}
          {errors.comment && <div className="text-danger text-xs mt-1">{errors.comment}</div>}
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending}
          >
            <Save className="w-4 h-4" /> Submit Evaluation
          </Button>
        </div>
      </div>
    </Modal>
  );
}
