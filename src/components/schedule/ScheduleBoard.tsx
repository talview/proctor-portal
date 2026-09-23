import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, FileEdit, Lock, Pencil, Save, Users } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import DataTable from '@/components/ui/DataTable';
import VendorTypeCell from '@/components/ui/VendorTypeCell';
import FilterBuilder, { type FilterFieldDef } from '@/components/ui/FilterBuilder';
import { logAudit } from '@/services/audit';
import { PROCTOR_TYPES } from '@/utils/constants';
import { useVendorOptions } from '@/hooks/useVendorOptions';
import { showAlert } from '@/components/ui/GlobalDialog';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import { useAllProctorsLookup } from '@/hooks/useAllProctorsLookup';
import { runWithConcurrency } from '@/utils/concurrency';
import { localDateString } from '@/utils/formatters';
import type { Evaluation, Proctor, ScheduledEventFilters } from '@/types';

/** One row of the Scheduled Events table -- either a single candidate's session
 * or a whole Multi Assign batch (see groupByGroupId), never both. */
interface ScheduleRow {
  key: string;
  items: Evaluation[];
  when: 'overdue' | 'today' | 'upcoming';
}

/** Overdue/Today/Upcoming pill -- replaces the old per-day red banner with a
 * real, sortable-in-spirit column so "why is this red" is answered by the row
 * itself instead of a section header above a whole day's worth of rows. */
function ScheduleStatusBadge({ when }: { when: ScheduleRow['when'] }) {
  const styles: Record<ScheduleRow['when'], string> = {
    overdue: 'bg-danger/15 text-danger border-danger/30',
    today: 'bg-accent/15 text-accent border-accent/30',
    upcoming: 'bg-text3/15 text-text3 border-text3/30',
  };
  const labels: Record<ScheduleRow['when'], string> = {
    overdue: 'Overdue',
    today: 'Today',
    upcoming: 'Upcoming',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full min-w-[80px] whitespace-nowrap text-[11px] font-bold border ${styles[when]}`}
    >
      {when === 'overdue' ? <AlertTriangle className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {labels[when]}
    </span>
  );
}

/** Buckets evaluation rows by group_id -- a Multi Assign batch shares one group_id
 * across every candidate (see EvaluationsPage's BulkAssessment), so this recovers
 * those batches as one unit. A row with no group_id (or one no sibling shares) falls
 * back to its own row id as the key, so it renders as a plain single-candidate group
 * -- individually-scheduled rows are completely unaffected by this. */
export function groupByGroupId<T extends { id: string; group_id?: string | null }>(items: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group_id || item.id;
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return Array.from(map.values());
}

// Helper function to check if evaluation can be done now (30 min before scheduled time)
function canEvaluateNow(scheduledDate: string, scheduledTime?: string): boolean {
  const now = new Date();
  const schedDate = new Date(scheduledDate);

  if (scheduledTime) {
    // Parse time like "10:00" or "14:30"
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    schedDate.setHours(hours, minutes, 0, 0);
    // Allow evaluation 30 minutes before scheduled time
    const unlockTime = new Date(schedDate.getTime() - 30 * 60 * 1000);
    return now >= unlockTime;
  } else {
    // If no time specified, allow on or after the scheduled date
    return now >= schedDate;
  }
}

// ============================================
// SCHEDULE BOARD -- a flat, sortable-in-spirit table of every pending
// (result IS NULL) demo/assessment session, one row per candidate or per
// Multi Assign batch. Shared by two very different contexts: Workspace
// renders it read-only (a reminder of what's coming up, no `onEvaluate*` props)
// and ScheduledEventsPage renders it with evaluate wired up (where the actual
// scoring happens) -- one implementation of the grouping/filtering logic
// instead of two that can drift, distinguished only by whether the caller
// passes an evaluate handler.
// ============================================
export function ScheduleBoard({
  onEvaluate,
  onEvaluateGroup,
  initialFilters,
}: {
  onEvaluate?: (evaluation: any) => void;
  onEvaluateGroup?: (items: Evaluation[]) => void;
  /** Pre-populates the filter row -- used by Workspace's Upcoming Tasks cards to
   * land here already scoped to the date/type the admin clicked through on,
   * instead of the bare, unfiltered board. Only read once, on mount. */
  initialFilters?: Partial<ScheduledEventFilters>;
}) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ScheduledEventFilters>({
    date: '',
    type: '',
    vendor: '',
    ptype: '',
    ...initialFilters,
  });
  const [editingItems, setEditingItems] = useState<Evaluation[] | null>(null);
  const { data: vendorOptions = [] } = useVendorOptions();
  const { data: allProctors = [] } = useAllProctorsLookup();

  // Unpaginated, same as the old Upcoming Tasks tab -- this is the currently-
  // pending backlog (result IS NULL), bounded by real scheduling capacity, not
  // something that grows without limit the way audit_log or evaluation *history*
  // does. Grouping accurately by day needs the true full set: a per-page count
  // would misstate "how many are on this day" the moment a day's items straddle
  // a page boundary, which is exactly the number this view exists to show.
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['workspace-schedule', user?.username, filters.date, filters.type],
    queryFn: async () => {
      let query = supabase
        .from('proctor_evaluations')
        .select('id, proctor_id, eval_type, panel_user, scheduled_date, scheduled_time, score_out_of, attempt_number, result, comment, score_obtained, session_code, candidate_id, section_id, group_id')
        .is('result', null)
        .order('scheduled_date', { ascending: true });

      if (user?.role !== 'admin') query = query.eq('panel_user', user?.username);
      if (filters.date) query = query.eq('scheduled_date', filters.date);
      if (filters.type) query = query.eq('eval_type', filters.type);

      const { data, error } = await query;
      if (error) throw error;
      return data as Evaluation[];
    },
  });

  // vendor/ptype filter the *joined* proctor client-side, same reason the old
  // Scheduled Events tab did: proctor_evaluations has no FK relationship
  // registered with proctors in PostgREST's schema cache, so an embedded-
  // resource filter isn't available server-side.
  const filtered = tasks.filter((item: any) => {
    const proctor = allProctors.find((p) => p.id === item.proctor_id);
    if (filters.vendor && proctor?.vendor !== filters.vendor) return false;
    if (filters.ptype && proctor?.ptype !== filters.ptype) return false;
    return true;
  });

  // Group by group_id first (a Multi Assign batch is still one row, not one
  // per candidate). `groups` preserves the query's ascending-by-date order
  // (each group takes the position of its first-seen item), so the table
  // below needs no separate day bucketing to read overdue-first.
  const groups = groupByGroupId(filtered);

  const today = localDateString();
  const tomorrowDate = new Date(today + 'T00:00:00');
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = localDateString(tomorrowDate);

  const formatDayLabel = (date: string) => {
    if (date === today) return 'Today';
    if (date === tomorrow) return 'Tomorrow';
    return new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  const rows: ScheduleRow[] = groups.map((items) => {
    const date = items[0].scheduled_date;
    const when: ScheduleRow['when'] = date < today ? 'overdue' : date === today ? 'today' : 'upcoming';
    return { key: items[0].group_id || items[0].id, items, when };
  });

  const isAdmin = user?.role === 'admin';

  const columns: ColumnDef<ScheduleRow, any>[] = [
    {
      id: 'status',
      header: 'Status',
      enableSorting: false,
      cell: ({ row }) => <ScheduleStatusBadge when={row.original.when} />,
      meta: { className: '!px-2' },
    },
    {
      id: 'date',
      accessorFn: (r) => r.items[0].scheduled_date,
      header: 'Date & Time',
      enableSorting: false,
      cell: ({ row }) => {
        const first = row.original.items[0];
        return (
          <div className="leading-tight whitespace-nowrap">
            <div className="text-[12px] font-semibold text-text">{formatDayLabel(first.scheduled_date)}</div>
            {first.scheduled_time && <div className="text-[10px] text-text3">{first.scheduled_time}</div>}
          </div>
        );
      },
    },
    {
      id: 'type',
      accessorFn: (r) => r.items[0].eval_type,
      header: 'Type',
      enableSorting: false,
      cell: ({ row }) => {
        const type = row.original.items[0].eval_type;
        return (
          <span
            className={`text-[11px] font-bold px-2 py-1 rounded whitespace-nowrap ${
              type === 'demo' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
            }`}
          >
            {type}
          </span>
        );
      },
      meta: { className: '!px-2' },
    },
    {
      id: 'candidate',
      header: 'Candidate',
      enableSorting: false,
      cell: ({ row }) => {
        const { items } = row.original;
        if (items.length > 1) {
          return (
            <div className="flex items-center gap-2 min-w-0">
              <Users className="w-3.5 h-3.5 text-text3 flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold text-text truncate">Group Assessment</div>
                <div className="text-[11px] text-text3">{items.length} candidates</div>
              </div>
            </div>
          );
        }
        const proctor = allProctors.find((p) => p.id === items[0].proctor_id);
        return (
          <div className="font-semibold text-text truncate max-w-[190px]" title={proctor?.name || 'Unknown'}>
            {proctor?.name || 'Unknown'}
          </div>
        );
      },
    },
    {
      id: 'vendor_type',
      header: 'Vendor',
      enableSorting: false,
      cell: ({ row }) => {
        const { items } = row.original;
        if (items.length > 1) return <span className="text-text3 text-[12px]">—</span>;
        const proctor = allProctors.find((p) => p.id === items[0].proctor_id);
        return <VendorTypeCell vendor={proctor?.vendor} ptype={proctor?.ptype} />;
      },
      meta: { className: '!px-2' },
    },
    ...(isAdmin
      ? [
          {
            id: 'panel',
            accessorFn: (r: ScheduleRow) => r.items[0].panel_user || '',
            header: 'Panel',
            enableSorting: false,
            cell: ({ row }: { row: { original: ScheduleRow } }) => (
              <span className="text-[12px] text-text2 whitespace-nowrap">{row.original.items[0].panel_user || '—'}</span>
            ),
          } as ColumnDef<ScheduleRow, any>,
        ]
      : []),
    {
      id: 'details',
      header: 'Details',
      enableSorting: false,
      cell: ({ row }) => {
        const first = row.original.items[0];
        return (
          <div className="text-[12px] text-text2 whitespace-nowrap">
            Attempt #{first.attempt_number}
            {first.score_out_of ? ` · /${first.score_out_of}` : ''}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => {
        const { items } = row.original;
        const first = items[0];
        const isGroup = items.length > 1;
        const canEvaluate = isGroup
          ? !!onEvaluateGroup && canEvaluateNow(first.scheduled_date, first.scheduled_time)
          : !!onEvaluate && canEvaluateNow(first.scheduled_date, first.scheduled_time);
        const hasHandler = isGroup ? !!onEvaluateGroup : !!onEvaluate;
        const formatDate = (dateStr: string) =>
          new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });

        return (
          <div className="flex items-center justify-end gap-1.5">
            {!hasHandler ? (
              <span className="text-[11px] font-semibold text-text3 px-2 py-1 rounded bg-surface2 whitespace-nowrap">
                Awaiting evaluation
              </span>
            ) : canEvaluate ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  isGroup
                    ? onEvaluateGroup!(items)
                    : onEvaluate!({ ...first, proctor: allProctors.find((p) => p.id === first.proctor_id) })
                }
              >
                <FileEdit className="w-3.5 h-3.5" /> Evaluate
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled
                title={`Unlocks 30min before: ${formatDate(first.scheduled_date)}${first.scheduled_time ? ' ' + first.scheduled_time : ''}`}
              >
                <Lock className="w-3.5 h-3.5" /> {formatDate(first.scheduled_date)}
              </Button>
            )}
            {isAdmin && (
              <Button variant="ghost" size="sm" onClick={() => setEditingItems(items)} title="Edit">
                <Pencil className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        );
      },
      meta: { className: 'text-right' },
    },
  ];

  const filterFields: FilterFieldDef[] = [
    { key: 'date', label: 'Date', type: 'date' },
    {
      key: 'type',
      label: 'Type',
      options: [
        { value: 'demo', label: 'Demo' },
        { value: 'assessment', label: 'Assessment' },
      ],
    },
    { key: 'vendor', label: 'Vendor', options: vendorOptions },
    { key: 'ptype', label: 'Proctor Type', options: PROCTOR_TYPES.map((t) => ({ value: t, label: t })) },
  ];

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <FilterBuilder
          fields={filterFields}
          values={{ date: filters.date || '', type: filters.type || '', vendor: filters.vendor || '', ptype: filters.ptype || '' }}
          onChange={(key, value) => setFilters({ ...filters, [key]: value } as ScheduledEventFilters)}
        />
        <ClearFiltersButton
          show={!!(filters.date || filters.type || filters.vendor || filters.ptype)}
          onClick={() => setFilters({ date: '', type: '', vendor: '', ptype: '' })}
        />
      </div>

      <DataTable
        data={rows}
        columns={columns}
        isLoading={isLoading}
        emptyMessage="Nothing scheduled"
        rowClassName={(r) => (r.when === 'overdue' ? 'bg-danger/5' : '')}
      />

      {/* Edit/Reschedule Modal -- items.length > 1 for a group edits every candidate's
          panel/date/time/score together, keeping them in sync as one group schedule.
          Rescheduling isn't evaluating, so this stays available from both the reminder
          board (Workspace) and the evaluate-enabled one (Scheduled Events) -- gated only
          by admin role, not by whether onEvaluate* was passed. */}
      {editingItems && (
        <RescheduleModal
          items={editingItems}
          proctors={allProctors}
          onClose={() => setEditingItems(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['workspace-schedule'] });
            setEditingItems(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================
// Reschedule/Edit Event Modal
// ============================================
interface RescheduleModalProps {
  /** One item edits a single candidate's schedule; more than one (a group -- every
   * member shares group_id) edits panel/date/time/score for every member at once,
   * keeping them in sync as one group schedule. All members of a real group already
   * share these fields, so items[0]'s values are the correct starting point either way. */
  items: Evaluation[];
  /** Already-loaded proctor lookup (e.g. useAllProctorsLookup) -- for the modal title
   * and each item's audit-log target, without a separate fetch per candidate. */
  proctors: Proctor[];
  onClose: () => void;
  onSuccess: () => void;
}

function RescheduleModal({ items, proctors, onClose, onSuccess }: RescheduleModalProps) {
  const first = items[0];
  const isGroup = items.length > 1;
  const [panelUser, setPanelUser] = useState(first.panel_user || '');
  const [scheduledDate, setScheduledDate] = useState(first.scheduled_date || '');
  const [scheduledTime, setScheduledTime] = useState(first.scheduled_time || '');
  const [scoreOutOf, setScoreOutOf] = useState(first.score_out_of?.toString() || '');

  // Fetch panel users (coordinators)
  const { data: panelUsers = [] } = useQuery({
    queryKey: ['panel-users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users')
        .select('username')
        .in('role', ['coordinator', 'admin']);

      if (error) throw error;
      return data.map((u: any) => u.username);
    },
    // Who's a coordinator/admin changes rarely -- no need to refetch every time
    // this modal opens.
    staleTime: 5 * 60_000,
  });

  const proctorName = (proctorId: string) => proctors.find((p) => p.id === proctorId)?.name;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!scheduledDate) throw new Error('Date is required');

      const today = localDateString();
      if (scheduledDate < today) {
        throw new Error('Cannot reschedule to a past date');
      }

      const actor = useAuthStore.getState().user?.username || useAuthStore.getState().user?.name || 'system';
      const results = await runWithConcurrency(items, 4, async (item) => {
        const { error } = await supabase.rpc('reschedule_evaluation', {
          p_evaluation_id: item.id,
          p_panel_user: panelUser || null,
          p_scheduled_date: scheduledDate,
          p_scheduled_time: scheduledTime || null,
          p_score_out_of: scoreOutOf ? parseFloat(scoreOutOf) : null,
        });
        if (error) throw error;

        await logAudit({
          action: 'Assessment Scheduled',
          target: proctorName(item.proctor_id) || item.proctor_id,
          detail: `Rescheduled${isGroup ? ' (group)' : ''} by ${actor} · ${scheduledDate}${scheduledTime ? ` ${scheduledTime}` : ''}`,
          user: actor,
        });
      });

      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        throw new Error(`${failed.length} of ${items.length} candidate(s) failed to update`);
      }
    },
    onSuccess: () => {
      showAlert(isGroup ? `${items.length} candidates rescheduled` : 'Event updated successfully', { tone: 'success' });
      onSuccess();
    },
    onError: (error: any) => {
      showAlert('Failed: ' + error.message, { tone: 'error' });
    },
  });

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={isGroup ? `Edit Group Assessment — ${items.length} candidates` : `Edit ${first.eval_type} — ${proctorName(first.proctor_id) || 'Unknown'}`}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Panel (Coordinator)
          </label>
          <Select
            options={[
              { value: '', label: 'Select...' },
              ...panelUsers.map((u: string) => ({ value: u, label: u })),
            ]}
            value={panelUser}
            onChange={(e) => setPanelUser(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Scheduled Date <span className="text-danger">*</span>
          </label>
          <Input
            type="date"
            value={scheduledDate}
            onChange={(e) => setScheduledDate(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Scheduled Time
          </label>
          <Input
            type="time"
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Score Out Of
          </label>
          <Input
            type="number"
            value={scoreOutOf}
            onChange={(e) => setScoreOutOf(e.target.value)}
            placeholder="e.g. 100"
            min="1"
          />
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            <Save className="w-4 h-4" /> Save Changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
