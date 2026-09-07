import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, ClipboardList, StickyNote, PartyPopper, AlertTriangle, FileEdit, Lock, Pencil, Trash2, Save, Users, Download, Upload } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Modal from '@/components/ui/Modal';
import { logAudit } from '@/services/audit';
import { PROCTOR_TYPES, EVAL_REASON_OPTIONS_BY_RESULT } from '@/utils/constants';
import { useManagedByOptions } from '@/hooks/useManagedByOptions';
import { showAlert } from '@/components/ui/GlobalDialog';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import Table from '@/components/ui/Table';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { useAllProctorsLookup } from '@/hooks/useAllProctorsLookup';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useGroupEvaluationActions } from '@/hooks/useGroupEvaluationActions';
import { runWithConcurrency } from '@/utils/concurrency';
import type { Evaluation, Note, Proctor, ScheduledEventFilters } from '@/types';

/** Buckets evaluation rows by group_id -- a Multi Assign batch shares one group_id
 * across every candidate (see EvaluationsPage's BulkAssessment), so this recovers
 * those batches as one unit. A row with no group_id (or one no sibling shares) falls
 * back to its own row id as the key, so it renders as a plain single-candidate group
 * -- individually-scheduled rows are completely unaffected by this. */
function groupByGroupId<T extends { id: string; group_id?: string | null }>(items: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group_id || item.id;
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return Array.from(map.values());
}

export default function WorkspacePage() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState(0);
  const [evaluationToReview, setEvaluationToReview] = useState<any | null>(null);
  const [groupToEvaluate, setGroupToEvaluate] = useState<Evaluation[] | null>(null);

  // Vendor can't reach this page at all -- RoleGate (App.tsx) restricts the
  // /workspace route to admin/coordinator before this component ever mounts.
  const title = user?.role === 'admin' ? 'Admin Workspace' : `${user?.name} — Workspace`;

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="text-[20px] font-bold text-text">{title}</h2>
        <p className="text-[13px] text-text2 mt-0.5">Today's tasks and personal notes</p>
      </div>

      {/* Tabs */}
      <div className="mb-6">
        <UnderlineTabs
          options={[
            { label: 'Upcoming Tasks', value: 0, icon: Calendar },
            { label: 'Scheduled Events', value: 1, icon: ClipboardList },
            { label: 'My Notes', value: 2, icon: StickyNote },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Tab Content */}
      {activeTab === 0 && (
        <UpcomingTasksTab
          onEvaluate={(task) => setEvaluationToReview(task)}
          onEvaluateGroup={(items) => setGroupToEvaluate(items)}
        />
      )}
      {activeTab === 1 && (
        <ScheduledEventsTab
          onEvaluate={(task) => setEvaluationToReview(task)}
          onEvaluateGroup={(items) => setGroupToEvaluate(items)}
        />
      )}
      {activeTab === 2 && <NotesTab />}

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

// ============================================
// TAB 1: Upcoming Tasks
// ============================================
function UpcomingTasksTab({
  onEvaluate,
  onEvaluateGroup,
}: {
  onEvaluate: (task: any) => void;
  onEvaluateGroup: (items: Evaluation[]) => void;
}) {
  const { user } = useAuthStore();
  const [dateFilter, setDateFilter] = useState('');

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['workspace-tasks', user?.username, dateFilter],
    queryFn: async () => {
      // Admin sees ALL panels, coordinator sees own
      let query = supabase
        .from('proctor_evaluations')
        .select('*')
        .is('result', null)
        .order('scheduled_date', { ascending: true });

      if (user?.role !== 'admin') {
        query = query.eq('panel_user', user?.username);
      }

      const { data, error } = await query;
      if (error) throw error;

      let filtered = data as Evaluation[];
      if (dateFilter) {
        filtered = filtered.filter(t => t.scheduled_date === dateFilter);
      }

      return filtered;
    },
  });

  // Fetch proctors for task cards
  const { data: proctors = [] } = useAllProctorsLookup();

  const today = new Date().toISOString().slice(0, 10);
  const overdueRows = tasks.filter(t => t.scheduled_date < today);
  const todayRows = tasks.filter(t => t.scheduled_date === today);
  const upcomingRows = tasks.filter(t => t.scheduled_date > today);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner size="md" />
          <p className="text-text2 text-sm">Loading tasks...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Date Filter */}
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <label className="text-[12px] text-text2">Filter by date:</label>
        <Input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          wrapperClassName="w-auto"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDateFilter('')}
        >
          Clear
        </Button>
      </div>

      {/* Tasks */}
      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <PartyPopper className="w-12 h-12 text-accent" />
          <h3 className="text-text font-semibold">No upcoming tasks</h3>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Overdue */}
          {overdueRows.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[12px] font-bold text-danger uppercase tracking-wider mb-2">
                <AlertTriangle className="w-3.5 h-3.5" /> Overdue
              </div>
              <div className="space-y-2">
                {groupByGroupId(overdueRows).map((group) =>
                  group.length > 1 ? (
                    <GroupScheduleCard key={group[0].group_id} items={group} when="overdue" showPanel={user?.role === 'admin'} onOpen={onEvaluateGroup} />
                  ) : (
                    <TaskCard
                      key={group[0].id}
                      task={group[0]}
                      proctor={proctors.find(p => p.id === group[0].proctor_id)}
                      when="overdue"
                      showPanel={user?.role === 'admin'}
                      onEvaluate={(item) => onEvaluate({ ...item, proctor: proctors.find((p) => p.id === item.proctor_id) })}
                    />
                  )
                )}
              </div>
            </div>
          )}

          {/* Today */}
          {todayRows.length > 0 && (
            <div>
              <div className="text-[12px] font-bold text-accent uppercase tracking-wider mb-2">
                Today
              </div>
              <div className="space-y-2">
                {groupByGroupId(todayRows).map((group) =>
                  group.length > 1 ? (
                    <GroupScheduleCard key={group[0].group_id} items={group} when="today" showPanel={user?.role === 'admin'} onOpen={onEvaluateGroup} />
                  ) : (
                    <TaskCard
                      key={group[0].id}
                      task={group[0]}
                      proctor={proctors.find(p => p.id === group[0].proctor_id)}
                      when="today"
                      showPanel={user?.role === 'admin'}
                      onEvaluate={(item) => onEvaluate({ ...item, proctor: proctors.find((p) => p.id === item.proctor_id) })}
                    />
                  )
                )}
              </div>
            </div>
          )}

          {/* Upcoming */}
          {upcomingRows.length > 0 && (
            <div>
              <div className="text-[12px] font-bold text-text3 uppercase tracking-wider mb-2">
                Upcoming
              </div>
              <div className="space-y-2">
                {groupByGroupId(upcomingRows).map((group) =>
                  group.length > 1 ? (
                    <GroupScheduleCard key={group[0].group_id} items={group} when="upcoming" showPanel={user?.role === 'admin'} onOpen={onEvaluateGroup} />
                  ) : (
                    <TaskCard
                      key={group[0].id}
                      task={group[0]}
                      proctor={proctors.find(p => p.id === group[0].proctor_id)}
                      when="upcoming"
                      showPanel={user?.role === 'admin'}
                      onEvaluate={(item) => onEvaluate({ ...item, proctor: proctors.find((p) => p.id === item.proctor_id) })}
                    />
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Evaluation;
  proctor?: Proctor;
  when: 'overdue' | 'today' | 'upcoming';
  showPanel: boolean;
  onEvaluate: (task: Evaluation & { proctor?: Proctor }) => void;
}

function TaskCard({ task, proctor, when, showPanel, onEvaluate }: TaskCardProps) {
  const borderColor =
    when === 'overdue'
      ? 'border-l-danger'
      : when === 'today'
      ? 'border-l-accent'
      : 'border-l-border';

  const canEvaluate = canEvaluateNow(task.scheduled_date, task.scheduled_time);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div
      className={`bg-surface border border-border rounded-lg p-4 flex items-center gap-3 border-l-[3px] ${borderColor}`}
    >
      <span
        className={`text-[11px] font-bold px-2 py-1 rounded ${
          task.eval_type === 'demo'
            ? 'bg-purple-500/15 text-purple-400'
            : 'bg-blue-500/15 text-blue-400'
        }`}
      >
        {task.eval_type}
      </span>

      <div className="flex-1">
        <div className="text-[13px] font-bold text-text">{proctor?.name || 'Unknown'}</div>
        <div className="text-[11px] text-text3">
          {showPanel && <span className="text-accent">Panel: {task.panel_user} · </span>}
          {task.score_out_of && <span>Score out of: {task.score_out_of} · </span>}
          {proctor?.vendor || proctor?.managed_by} · {proctor?.ptype} · Attempt #{task.attempt_number}
          {task.scheduled_time && ` · ${task.scheduled_time}`}
        </div>
      </div>

      <div className={`text-[12px] ${when === 'overdue' ? 'text-danger' : 'text-text3'}`}>
        {formatDate(task.scheduled_date)}
      </div>

      {canEvaluate ? (
        <Button variant="primary" size="sm" onClick={() => onEvaluate({ ...task, proctor })}>
<FileEdit className="w-3.5 h-3.5" /> Evaluate
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled
          title={`Unlocks 30min before: ${formatDate(task.scheduled_date)}${task.scheduled_time ? ' ' + task.scheduled_time : ''}`}
        >
          <Lock className="w-3.5 h-3.5" /> {formatDate(task.scheduled_date)}
        </Button>
      )}
    </div>
  );
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

/** One card per Group Assessment session (a Multi Assign batch -- see EvaluationsPage's
 * BulkAssessment, and groupByGroupId above) instead of one per candidate. Laid out just
 * like TaskCard (single button on the right) so a group is no different in kind from
 * any other schedule on this tab -- "Evaluate" opens GroupEvaluationModal, which is
 * where the candidate list and the Download/Upload actions actually live. */
function GroupScheduleCard({
  items,
  when,
  showPanel,
  onOpen,
}: {
  items: Evaluation[];
  when: 'overdue' | 'today' | 'upcoming';
  showPanel: boolean;
  onOpen: (items: Evaluation[]) => void;
}) {
  const first = items[0];

  const borderColor =
    when === 'overdue' ? 'border-l-danger' : when === 'today' ? 'border-l-accent' : 'border-l-border';
  const canEvaluate = canEvaluateNow(first.scheduled_date, first.scheduled_time);

  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div
      className={`bg-surface border border-border rounded-lg p-4 flex items-center gap-3 border-l-[3px] ${borderColor}`}
    >
      <span className="text-[11px] font-bold px-2 py-1 rounded bg-blue-500/15 text-blue-400 flex-shrink-0">
        {first.eval_type}
      </span>

      <Users className="w-4 h-4 text-text3 flex-shrink-0" />

      <div className="flex-1">
        <div className="text-[13px] font-bold text-text">Group Assessment · {items.length} candidates</div>
        <div className="text-[11px] text-text3">
          {showPanel && <span className="text-accent">Panel: {first.panel_user} · </span>}
          {first.score_out_of && <span>Score out of: {first.score_out_of} · </span>}
          {items.length} candidate{items.length === 1 ? '' : 's'} awaiting a result
          {first.scheduled_time && ` · ${first.scheduled_time}`}
        </div>
      </div>

      <div className={`text-[12px] ${when === 'overdue' ? 'text-danger' : 'text-text3'}`}>
        {formatDate(first.scheduled_date)}
      </div>

      {canEvaluate ? (
        <Button variant="primary" size="sm" onClick={() => onOpen(items)}>
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
    </div>
  );
}

// ============================================
// TAB 2: Scheduled Events
// ============================================
function ScheduledEventsTab({
  onEvaluate,
  onEvaluateGroup,
}: {
  onEvaluate: (evaluation: any) => void;
  onEvaluateGroup: (items: Evaluation[]) => void;
}) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ScheduledEventFilters>({
    date: '',
    type: '',
    vendor: '',
    ptype: '',
  });
  const [editingItems, setEditingItems] = useState<Evaluation[] | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const { data: managedByOptions = [] } = useManagedByOptions();

  // Only fetch evaluations where result is null (pending/scheduled). `date`/`type`
  // are plain columns on proctor_evaluations, so they filter server-side below.
  // `vendor`/`ptype` filter on the *joined* proctor -- proctor_evaluations has no
  // FK relationship registered with `proctors` in PostgREST's schema cache (verified
  // live: a `select=*,proctors(...)` embed 400s with PGRST200 "no relationship
  // found"), so an embedded-resource filter isn't available. They're re-applied
  // client-side below instead, to just the rows on the current page. Tradeoff:
  // when either is active, a "page" of nominally PAGE_SIZE rows can render fewer
  // visible rows, and the pagination footer's count reflects the date/type-filtered
  // total from the server, not the vendor/ptype-narrowed one actually on screen.
  const { data: pageResult, isLoading, isFetching } = usePaginatedQuery<Evaluation>({
    queryKey: ['scheduled-events', user?.username, filters.date, filters.type],
    table: 'proctor_evaluations',
    filters: (q) => {
      let query = q.is('result', null);
      if (user?.role !== 'admin') query = query.eq('panel_user', user?.username);
      if (filters.date) query = query.eq('scheduled_date', filters.date);
      if (filters.type) query = query.eq('eval_type', filters.type);
      return query;
    },
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'scheduled_date', ascending: true }, // Ascending order like HTML
  });

  const scheduled = pageResult?.data ?? [];
  const totalCount = pageResult?.count ?? 0;

  // Fetch all proctors for filtering/join
  const { data: allProctors = [] } = useAllProctorsLookup();

  const filteredData = scheduled.filter((item: any) => {
    const proctor = allProctors.find(p => p.id === item.proctor_id);
    if (filters.vendor && (proctor?.vendor || proctor?.managed_by) !== filters.vendor) return false;
    if (filters.ptype && proctor?.ptype !== filters.ptype) return false;
    return true;
  }).map((item: any) => ({
    ...item,
    proctor: allProctors.find(p => p.id === item.proctor_id)
  }));

  // Same group_id grouping as Upcoming Tasks -- a Multi Assign batch shows as one row
  // here too instead of one per candidate. Grouped client-side over the current page's
  // fetched rows (same tradeoff already noted above for the vendor/ptype filter: a
  // group could in principle straddle a page boundary, though in practice this tab is
  // scoped to result IS NULL, so a batch's members generally stay together until
  // someone starts recording results).
  const tableRows = groupByGroupId(filteredData).map((group) =>
    group.length > 1 ? { ...group[0], _isGroup: true as const, _groupItems: group } : group[0]
  );

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          type="date"
          value={filters.date}
          onChange={(e) => {
            setFilters({ ...filters, date: e.target.value });
            setPage(1);
          }}
          wrapperClassName="w-auto"
        />
        <Select
          options={[
            { value: '', label: 'All Types' },
            { value: 'demo', label: 'Demo' },
            { value: 'assessment', label: 'Assessment' },
          ]}
          value={filters.type}
          onChange={(e) => {
            setFilters({ ...filters, type: e.target.value as any });
            setPage(1);
          }}
          wrapperClassName="min-w-[140px]"
        />
        <Select
            options={[
              { value: '', label: 'All Vendors' },
              ...managedByOptions,
            ]}
          value={filters.vendor}
          onChange={(e) => {
            setFilters({ ...filters, vendor: e.target.value as any });
            setPage(1);
          }}
          wrapperClassName="min-w-[160px]"
        />
        <Select
          options={[
            { value: '', label: 'All Proctor Types' },
            ...PROCTOR_TYPES.map((t) => ({ value: t, label: t })),
          ]}
          value={filters.ptype}
          onChange={(e) => {
            setFilters({ ...filters, ptype: e.target.value as any });
            setPage(1);
          }}
          wrapperClassName="min-w-[160px]"
        />
        <ClearFiltersButton
          show={!!(filters.date || filters.type || filters.vendor || filters.ptype)}
          onClick={() => {
            setFilters({ date: '', type: '', vendor: '', ptype: '' });
            setPage(1);
          }}
        />
      </div>

      {/* Table */}
      <Table
        data={tableRows}
        isLoading={isLoading}
        emptyMessage="No scheduled events"
        pagination={{ page, pageSize: PAGE_SIZE, count: totalCount, isFetching, onPageChange: setPage }}
        columns={[
          {
            header: 'Proctor',
            accessor: (item: any) =>
              item._isGroup ? (
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-text3 flex-shrink-0" />
                  <span className="text-[13px] font-semibold text-text">Group Assessment · {item._groupItems.length} candidates</span>
                </div>
              ) : (
                <>
                  <div className="text-[13px] font-semibold text-text">{item.proctor?.name || 'Unknown'}</div>
                  <div className="text-[11px] text-text3">
                    {item.proctor?.email || ''} · {item.proctor?.vendor || item.proctor?.managed_by}
                  </div>
                </>
              ),
          },
          {
            header: 'Type',
            accessor: (item: any) => (
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                item.eval_type === 'demo'
                  ? 'bg-purple-500/15 text-purple-400'
                  : 'bg-blue-500/15 text-blue-400'
              }`}>
                {item.eval_type}
              </span>
            ),
          },
          { header: 'Panel', accessor: (item: any) => item.panel_user, className: 'text-[12px] text-text2' },
          {
            header: 'Scheduled Date & Time',
            accessor: (item: any) => (
              <>
                {formatDate(item.scheduled_date)}
                {item.scheduled_time && ` · ${item.scheduled_time}`}
              </>
            ),
            className: 'text-[12px] text-text2',
          },
          {
            header: 'Attempt',
            accessor: (item: any) =>
              item._isGroup ? (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-surface2 text-text">
                  {item._groupItems.length} candidates
                </span>
              ) : (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-surface2 text-text">
                  #{item.attempt_number}
                </span>
              ),
          },
          {
            header: 'Status',
            accessor: () => (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-accent">
                <Calendar className="w-3 h-3" /> Scheduled
              </span>
            ),
          },
          {
            header: 'Score Out Of',
            accessor: (item: any) => item.score_out_of || '—',
            className: 'text-[11px] font-mono text-text2',
          },
          {
            header: 'Actions',
            accessor: (item: any) =>
              item._isGroup ? (
                <div className="flex gap-1">
                  {canEvaluateNow(item.scheduled_date, item.scheduled_time) ? (
                    <Button variant="primary" size="sm" onClick={() => onEvaluateGroup(item._groupItems)}>
                      <FileEdit className="w-3.5 h-3.5" /> Evaluate
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled
                      title={`Unlocks 30min before: ${formatDate(item.scheduled_date)}${item.scheduled_time ? ' ' + item.scheduled_time : ''}`}
                    >
                      <Lock className="w-3.5 h-3.5" /> {formatDate(item.scheduled_date)}
                    </Button>
                  )}
                  {user?.role === 'admin' && (
                    <Button variant="ghost" size="sm" onClick={() => setEditingItems(item._groupItems)}>
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex gap-1">
                  {canEvaluateNow(item.scheduled_date, item.scheduled_time) ? (
                    <Button variant="primary" size="sm" onClick={() => onEvaluate(item)}>
                      <FileEdit className="w-3.5 h-3.5" /> Evaluate
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled
                      title={`Unlocks 30min before: ${formatDate(item.scheduled_date)}${item.scheduled_time ? ' ' + item.scheduled_time : ''}`}
                    >
                      <Lock className="w-3.5 h-3.5" /> {formatDate(item.scheduled_date)}
                    </Button>
                  )}
                  {user?.role === 'admin' && (
                    <Button variant="ghost" size="sm" onClick={() => setEditingItems([item])}>
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Button>
                  )}
                </div>
              ),
          },
        ]}
      />

      {/* Edit/Reschedule Modal -- items.length > 1 for a group edits every candidate's
          panel/date/time/score together, keeping them in sync as one group schedule. */}
      {editingItems && (
        <RescheduleModal
          items={editingItems}
          proctors={allProctors}
          onClose={() => setEditingItems(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['scheduled-events'] });
            queryClient.invalidateQueries({ queryKey: ['workspace-tasks'] });
            setEditingItems(null);
          }}
        />
      )}
    </div>
  );
}

/** What "Evaluate" opens for a Group Assessment session, from either tab -- the
 * candidate list plus the Download/Upload actions that used to live inline on the
 * card/row itself. Centralizing them here is what let both places shrink back down
 * to the same single "Evaluate" button every other schedule type already has. */
function GroupEvaluationModal({
  items,
  onClose,
}: {
  items: Evaluation[];
  onClose: () => void;
}) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const { data: proctors = [] } = useAllProctorsLookup();
  const { busy, handleDownload, handleUpload } = useGroupEvaluationActions(items, proctors);
  const first = items[0];
  const canEvaluate = canEvaluateNow(first.scheduled_date, first.scheduled_time);

  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Modal isOpen={true} onClose={onClose} title={`Group Assessment · ${items.length} candidates`}>
      <div className="space-y-4">
        <div className="text-[12px] text-text3">
          <span className="text-accent">Panel: {first.panel_user}</span>
          {' · '}{formatDate(first.scheduled_date)}
          {first.scheduled_time && ` · ${first.scheduled_time}`}
          {first.score_out_of ? ` · Score out of: ${first.score_out_of}` : ''}
        </div>

        <div className="rounded-md border border-border divide-y divide-border overflow-hidden max-h-80 overflow-y-auto">
          {items.map((task) => {
            const proctor = proctors.find((p) => p.id === task.proctor_id);
            return (
              <div key={task.id} className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface2/40">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-text truncate">{proctor?.name || 'Unknown'}</div>
                  <div className="text-[10px] text-text3">
                    {(proctor?.vendor || proctor?.managed_by) && `${proctor?.vendor || proctor?.managed_by} · `}
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
        .select('id, name, vendor, managed_by, email')
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
      await queryClient.invalidateQueries({ queryKey: ['workspace-tasks'] });
      await queryClient.invalidateQueries({ queryKey: ['scheduled-events'] });
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
            <strong>{proctor?.name || 'Unknown'}</strong> ({proctor?.vendor || proctor?.managed_by || '—'}) · {evaluation.eval_type} · Panel: {evaluation.panel_user} · Scheduled: {formatDateTime(evaluation.scheduled_date, evaluation.scheduled_time)} · Attempt #{evaluation.attempt_number}
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

function formatDateTime(date?: string, time?: string) {
  if (!date) return '—';
  const d = new Date(date);
  const dateStr = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  return time ? `${dateStr} ${time}` : dateStr;
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
  });

  const proctorName = (proctorId: string) => proctors.find((p) => p.id === proctorId)?.name;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!scheduledDate) throw new Error('Date is required');

      const today = new Date().toISOString().slice(0, 10);
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

// ============================================
// TAB 3: My Notes
// ============================================
function NotesTab() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['user-notes', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_notes')
        .select('*')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as Note[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('user_notes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-notes'] });
    },
  });

  const toggleDoneMutation = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const { error } = await supabase.from('user_notes').update({ done }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-notes'] });
    },
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-[13px] text-text2">Your private notes — only visible to you</div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditingNote(null);
            setShowModal(true);
          }}
        >
          + Add Note
        </Button>
      </div>

      {/* Notes Grid */}
      {isLoading ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <LoadingSpinner size="md" />
          <p className="text-text2 text-sm">Loading notes...</p>
        </div>
      ) : notes.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet" message="Click + Add Note to create one." compact />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onEdit={() => {
                setEditingNote(note);
                setShowModal(true);
              }}
              onDelete={() => deleteMutation.mutate(note.id)}
              onToggleDone={() =>
                toggleDoneMutation.mutate({ id: note.id, done: !note.done })
              }
            />
          ))}
        </div>
      )}

      {/* Note Modal */}
      {showModal && (
        <NoteModal
          note={editingNote}
          onClose={() => {
            setShowModal(false);
            setEditingNote(null);
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['user-notes'] });
            setShowModal(false);
            setEditingNote(null);
          }}
        />
      )}
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onEdit: () => void;
  onDelete: () => void;
  onToggleDone: () => void;
}

function NoteCard({ note, onEdit, onDelete, onToggleDone }: NoteCardProps) {
  const colorClasses = {
    red: 'bg-red-500/10 border-red-500/30',
    yellow: 'bg-yellow-500/10 border-yellow-500/30',
    green: 'bg-green-500/10 border-green-500/30',
    blue: 'bg-blue-500/10 border-blue-500/30',
  };

  const noteColor = note.colour || note.color || 'yellow';

  return (
    <div
      className={`border rounded-lg p-4 ${colorClasses[noteColor as keyof typeof colorClasses]} ${
        note.done ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3
          className={`text-[14px] font-bold text-text ${
            note.done ? 'line-through' : ''
          }`}
        >
          {note.title}
        </h3>
        <input
          type="checkbox"
          checked={note.done}
          onChange={onToggleDone}
          className="w-4 h-4 accent-accent cursor-pointer"
        />
      </div>
      <p className="text-[12px] text-text2 mb-3 whitespace-pre-wrap">{note.body}</p>
      {note.due_date && (
        <div className="flex items-center gap-1 text-[11px] text-text3 mb-3">
          <Calendar className="w-3 h-3" /> Due: {new Date(note.due_date).toLocaleDateString('en-IN')}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" /> Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

interface NoteModalProps {
  note: Note | null;
  onClose: () => void;
  onSuccess: () => void;
}

function NoteModal({ note, onClose, onSuccess }: NoteModalProps) {
  const { user } = useAuthStore();
  const [title, setTitle] = useState(note?.title || '');
  const [body, setBody] = useState(note?.body || '');
  const [color, setColor] = useState<'red' | 'yellow' | 'green' | 'blue'>(
    note?.colour || note?.color || 'yellow'
  );
  const [dueDate, setDueDate] = useState(note?.due_date || '');

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Title is required');

      const noteData = {
        title: title.trim(),
        body: body.trim(),
        colour: color, // Database uses 'colour' not 'color'
        due_date: dueDate || null,
        done: note?.done || false,
        user_id: user?.id,
      };

      if (note) {
        const { error } = await supabase
          .from('user_notes')
          .update(noteData)
          .eq('id', note.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('user_notes').insert(noteData);
        if (error) throw error;
      }
    },
    onSuccess,
    onError: (error: any) => {
      showAlert('Error: ' + error.message, { tone: 'error' });
    },
  });

  return (
    <Modal isOpen={true} onClose={onClose} title={note ? 'Edit Note' : 'Add Note'}>
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Title *
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Note title"
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Note content..."
            rows={4}
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-[13px] text-text outline-none focus:border-accent resize-none"
          />
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">Color</label>
          <div className="flex gap-2">
            {(['red', 'yellow', 'green', 'blue'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-10 h-10 rounded border-2 ${
                  color === c ? 'border-text' : 'border-transparent'
                } ${
                  c === 'red'
                    ? 'bg-red-500/30'
                    : c === 'yellow'
                    ? 'bg-yellow-500/30'
                    : c === 'green'
                    ? 'bg-green-500/30'
                    : 'bg-blue-500/30'
                }`}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Due Date (Optional)
          </label>
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
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
            <Save className="w-4 h-4" /> Save Note
          </Button>
        </div>
      </div>
    </Modal>
  );
}
