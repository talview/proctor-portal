import { useRef, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Video, FileEdit, BarChart3, Download, CheckCircle2, User, Users, Upload, AlertTriangle, RefreshCw, Save, ExternalLink, ChevronDown, History, XCircle } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { useCursorPaginatedQuery } from '@/hooks/useCursorPaginatedQuery';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import DataTable from '@/components/ui/DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import { logAudit } from '@/services/audit';
import { downloadCsv, parseCsv } from '@/lib/csv';
import { localDateString } from '@/utils/formatters';
import { orIlikeFilter } from '@/utils/postgrest';
import { showAlert } from '@/components/ui/GlobalDialog';
import { PROCTOR_TYPES, EVAL_REASON_OPTIONS_BY_RESULT } from '@/utils/constants';
import { useVendorOptions } from '@/hooks/useVendorOptions';
import { useAssessmentReadyProctors } from '@/hooks/useAssessmentReadyProctors';
import { runWithConcurrency } from '@/utils/concurrency';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import CompactSegmentedTabs from '@/components/ui/CompactSegmentedTabs';
import type { Proctor } from '@/types';

export default function EvaluationsPage() {
  const [activeTab, setActiveTab] = useState(0);
  const [bulkAssessConfig, setBulkAssessConfig] = useState<{
    panel: string;
    date: string;
    time: string;
    score: number;
  } | null>(null);

  // Cleanup global state on unmount
  useEffect(() => {
    return () => {
      delete (window as any)._bulkAssessConfig;
    };
  }, []);

  return (
    <div>
      {/* Main Tabs */}
      <div className="mb-6">
        <UnderlineTabs
          options={[
            { label: 'Demo', value: 0, icon: Video },
            { label: 'Assessment', value: 1, icon: FileEdit },
            { label: 'Results', value: 2, icon: BarChart3 },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Tab Content */}
      {activeTab === 0 && <DemoTab />}
      {activeTab === 1 && <AssessmentTab bulkAssessConfig={bulkAssessConfig} setBulkAssessConfig={setBulkAssessConfig} />}
      {activeTab === 2 && <ResultsTab />}
    </div>
  );
}

function usePanelUsers() {
  return useQuery({
    queryKey: ['panel-users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('users')
        .select('username')
        .in('role', ['coordinator', 'admin']);

      if (error) throw error;
      return (data || []).map((u: any) => u.username).filter(Boolean) as string[];
    },
    // Who's a coordinator/admin changes rarely -- no need to refetch on every mount
    // or window refocus. A new user account will show up here within 5 minutes.
    staleTime: 5 * 60_000,
  });
}

function DemoTab() {
  const [search, setSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selectedProctors, setSelectedProctors] = useState<Set<string>>(new Set());
  const [panelUser, setPanelUser] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [scoreOutOf, setScoreOutOf] = useState('');
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isVendor = user?.role === 'vendor';
  const { data: panelUsers = [] } = usePanelUsers();
  const { data: vendorOptions = [] } = useVendorOptions();

  // Fetch proctors with demo_ready = 'ready'
  const { data: proctors = [], isLoading } = useQuery({
    queryKey: ['demo-ready-proctors'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctors')
        .select('id, name, email, vendor, ptype, demo_ready_attempt, at')
        .eq('demo_ready', 'ready')
        .order('at', { ascending: false });

      if (error) throw error;
      return data as Proctor[];
    },
  });

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      if (!panelUser) throw new Error('Select a coordinator');
      if (!scheduledDate) throw new Error('Select a scheduled date');
      if (!scheduledTime) throw new Error('Select a scheduled time');
      if (!scoreOutOf || Number(scoreOutOf) < 1) throw new Error('Enter a valid score out of');

      const now = new Date();
      const today = localDateString(now);
      if (scheduledDate < today) throw new Error('Cannot schedule on a past date');
      if (scheduledDate === today) {
        const [h, m] = scheduledTime.split(':').map(Number);
        const scheduled = new Date();
        scheduled.setHours(h, m, 0, 0);
        if (scheduled <= now) throw new Error('Cannot schedule at a past time for today');
      }

      const selected = proctors.filter((p) => selectedProctors.has(p.id));
      if (!selected.length) throw new Error('No proctors selected');

      await Promise.all(selected.map(async (p) => {
        const { data: attempt, error: scheduleError } = await supabase.rpc('schedule_evaluation', {
          p_proctor_id: p.id,
          p_eval_type: 'demo',
          p_panel_user: panelUser,
          p_scheduled_date: scheduledDate,
          p_scheduled_time: scheduledTime,
          p_score_out_of: Number(scoreOutOf),
          });

        if (scheduleError) throw scheduleError;

        await logAudit({
          action: 'Demo Scheduled',
          target: p.name,
          detail: `Panel: ${panelUser} · Attempt ${attempt} · Date: ${scheduledDate} ${scheduledTime} · by ${user?.username || user?.name || 'system'}`,
          user: user?.username || user?.name || null,
        });
      }));
    },
    onSuccess: async () => {
      showAlert(`Demo scheduled for ${selectedProctors.size} proctor${selectedProctors.size !== 1 ? 's' : ''}`, { tone: 'success' });
      setSelectedProctors(new Set());
      setPanelUser('');
      setScheduledDate('');
      setScheduledTime('');
      setScoreOutOf('');
      await queryClient.invalidateQueries({ queryKey: ['demo-ready-proctors'] });
      await queryClient.invalidateQueries({ queryKey: ['evaluations-results', 'demo'] });
      await queryClient.invalidateQueries({ queryKey: ['proctors'] });
    },
    onError: (error: any) => {
      showAlert('Failed to schedule demo: ' + error.message, { tone: 'error' });
    },
  });

  // Filter proctors
  const filteredProctors = proctors.filter((p) => {
    if (search) {
      const s = search.toLowerCase();
      if (!(p.name || '').toLowerCase().includes(s) && !(p.email || '').toLowerCase().includes(s)) {
        return false;
      }
    }
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    if (typeFilter && p.ptype !== typeFilter) return false;
    return true;
  });

  const exportReadyList = () => {
    if (filteredProctors.length === 0) {
      showAlert('No proctors to export', { tone: 'error' });
      return;
    }

    downloadCsv(
      `demo_ready_list_${localDateString()}.csv`,
      ['Name', 'Vendor', 'Type', 'Demo Status', 'Attempts'],
      filteredProctors.map((p) => [
        p.name || '',
        p.vendor || '',
        p.ptype || '',
        'Ready',
        String(p.demo_ready_attempt || 0),
      ])
    );
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedProctors(new Set(filteredProctors.map(p => p.id)));
    } else {
      setSelectedProctors(new Set());
    }
  };

  const toggleProctor = (id: string) => {
    const newSet = new Set(selectedProctors);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedProctors(newSet);
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Name, email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName="flex-1 min-w-[180px]"
        />
        {!isVendor && (
          <Select
            options={[
              { value: '', label: 'All Vendors' },
              ...vendorOptions,
            ]}
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            wrapperClassName="min-w-[160px]"
          />
        )}
        <Select
          options={[
            { value: '', label: 'All Types' },
            ...PROCTOR_TYPES.map(t => ({ value: t, label: t })),
          ]}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          wrapperClassName="min-w-[120px]"
        />
        <ClearFiltersButton
          show={!!(search || vendorFilter || typeFilter)}
          onClick={() => {
            setSearch('');
            setVendorFilter('');
            setTypeFilter('');
          }}
        />
        <Button variant="ghost" size="sm" onClick={exportReadyList}>
<Download className="w-3.5 h-3.5" /> Export
        </Button>
      </div>

      {/* Info Banner */}
      <div className="bg-info/10 border border-info/30 rounded-lg p-3 mb-4 text-xs text-info">
        Only proctors with Demo status <strong>Ready</strong> appear here. Coordinators mark readiness from the In Progress tab.
      </div>

      {/* Table */}
      <div className="mb-4">
        <DataTable
          data={filteredProctors}
          isLoading={isLoading}
          emptyMessage="No proctors ready for demo"
          columns={[
            {
              id: 'select',
              // A header checkbox toggles all, matching every other selectable table
              // in the app (ProctorsPage, InterviewSelectsPage) -- this used to be a
              // separate "Select All" button/label floating in the toolbar above,
              // which looked inconsistent with the rest of the app's tables.
              header: () => (
                <input
                  type="checkbox"
                  checked={selectedProctors.size === filteredProctors.length && filteredProctors.length > 0}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="w-3.5 h-3.5 accent-accent cursor-pointer"
                />
              ),
              enableSorting: false,
              meta: { className: 'w-8' },
              cell: ({ row }) => (
                <input
                  type="checkbox"
                  checked={selectedProctors.has(row.original.id)}
                  onChange={() => toggleProctor(row.original.id)}
                  className="w-3.5 h-3.5 accent-accent cursor-pointer"
                />
              ),
            },
            { id: 'name', header: 'Name', enableSorting: false, cell: ({ row }) => row.original.name, meta: { className: 'text-[13px] text-text font-semibold' } },
            { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-[12px] text-text2' } },
            {
              id: 'ptype',
              header: 'Type',
              enableSorting: false,
              cell: ({ row }) => (
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-info/10 text-info">
                  {row.original.ptype}
                </span>
              ),
            },
            {
              id: 'demo_status',
              header: 'Demo Status',
              enableSorting: false,
              cell: () => <span className="text-[11px] font-bold text-info">Ready</span>,
            },
            {
              id: 'attempts',
              header: 'Attempts',
              enableSorting: false,
              cell: ({ row }) => row.original.demo_ready_attempt || 0,
              meta: { className: 'text-[12px] text-text3' },
            },
          ] satisfies ColumnDef<Proctor, any>[]}
        />
      </div>

      {/* Assignment Panel - shown when proctors selected */}
      {selectedProctors.size > 0 && (
        <div className="bg-surface border-2 border-accent rounded-lg p-5 max-w-2xl">
          <div className="text-sm font-bold text-text mb-4">
            Assign Demo Panel ({selectedProctors.size} selected)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Panel (Coordinator) <span className="text-danger">*</span>
              </label>
              <Select
                options={[
                  { value: '', label: 'Select coordinator...' },
                  ...panelUsers.map((u) => ({ value: u, label: u })),
                ]}
                value={panelUser}
                onChange={(e) => setPanelUser(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Scheduled Date <span className="text-danger">*</span>
              </label>
              <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Scheduled Time <span className="text-danger">*</span>
              </label>
              <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Score Out Of <span className="text-danger">*</span>
              </label>
              <Input type="number" min={1} placeholder="e.g. 100" value={scoreOutOf} onChange={(e) => setScoreOutOf(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={() => scheduleMutation.mutate()}
              disabled={scheduleMutation.isPending}
            >
              {scheduleMutation.isPending ? 'Scheduling...' : <><CheckCircle2 className="w-4 h-4" /> Schedule Demo</>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface BulkAssessConfig {
  panel: string;
  date: string;
  time: string;
  score: number;
}

function AssessmentTab({ bulkAssessConfig, setBulkAssessConfig }: {
  bulkAssessConfig: BulkAssessConfig | null;
  setBulkAssessConfig: (cfg: BulkAssessConfig | null) => void;
}) {
  const [subTab, setSubTab] = useState(0);

  return (
    <div>
      {/* Sub Tabs */}
      <div className="mb-4">
        <CompactSegmentedTabs
          options={[
            { label: 'Individual Assign', value: 0, icon: User },
            { label: 'Multi Assign (Bulk)', value: 1, icon: Users },
          ]}
          value={subTab}
          onChange={setSubTab}
        />
      </div>

      {subTab === 0 ? <IndividualAssessment /> : <BulkAssessment bulkAssessConfig={bulkAssessConfig} setBulkAssessConfig={setBulkAssessConfig} />}
    </div>
  );
}

function IndividualAssessment() {
  const [search, setSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selectedProctor, setSelectedProctor] = useState<string | null>(null);
  const [panelUser, setPanelUser] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [scoreOutOf, setScoreOutOf] = useState('');
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isVendor = user?.role === 'vendor';
  const { data: panelUsers = [] } = usePanelUsers();
  const { data: vendorOptions = [] } = useVendorOptions();

  // Fetch proctors with assessment_ready = 'ready' -- shared with BulkAssessment so
  // switching between the two sub-tabs reuses one cache entry instead of refetching.
  const { data: proctors = [], isLoading } = useAssessmentReadyProctors();

  const selectedProctorData = proctors.find((p) => p.id === selectedProctor) || null;

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProctorData) throw new Error('Select a proctor');
      if (!panelUser) throw new Error('Select a coordinator');
      if (!scheduledDate) throw new Error('Select a scheduled date');
      if (!scheduledTime) throw new Error('Select a scheduled time');
      if (!scoreOutOf || Number(scoreOutOf) < 1) throw new Error('Enter a valid score out of');

      const now = new Date();
      const today = localDateString(now);
      if (scheduledDate < today) throw new Error('Cannot schedule on a past date');
      if (scheduledDate === today) {
        const [h, m] = scheduledTime.split(':').map(Number);
        const scheduled = new Date();
        scheduled.setHours(h, m, 0, 0);
        if (scheduled <= now) throw new Error('Cannot schedule at a past time for today');
      }

      const { data: attempt, error: scheduleError } = await supabase.rpc('schedule_evaluation', {
        p_proctor_id: selectedProctorData.id,
        p_eval_type: 'assessment',
        p_panel_user: panelUser,
        p_scheduled_date: scheduledDate,
        p_scheduled_time: scheduledTime,
        p_score_out_of: Number(scoreOutOf),
        p_group_id: crypto.randomUUID(),
      });

      if (scheduleError) throw scheduleError;

      await logAudit({
        action: 'Assessment Scheduled',
        target: selectedProctorData.name,
        detail: `Panel: ${panelUser} · Attempt ${attempt} · Date: ${scheduledDate} ${scheduledTime} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    },
    onSuccess: async () => {
      showAlert('Assessment scheduled successfully', { tone: 'success' });
      setSelectedProctor(null);
      setPanelUser('');
      setScheduledDate('');
      setScheduledTime('');
      setScoreOutOf('');
      await queryClient.invalidateQueries({ queryKey: ['assessment-ready-proctors'] });
      await queryClient.invalidateQueries({ queryKey: ['evaluations-results', 'assessment'] });
      await queryClient.invalidateQueries({ queryKey: ['proctors'] });
    },
    onError: (error: any) => {
      showAlert('Failed to schedule assessment: ' + error.message, { tone: 'error' });
    },
  });

  // Filter proctors
  const filteredProctors = proctors.filter((p) => {
    if (search) {
      const s = search.toLowerCase();
      if (!(p.name || '').toLowerCase().includes(s) && !(p.email || '').toLowerCase().includes(s)) {
        return false;
      }
    }
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    if (typeFilter && p.ptype !== typeFilter) return false;
    return true;
  });

  const exportReadyList = () => {
    if (filteredProctors.length === 0) {
      showAlert('No proctors to export', { tone: 'error' });
      return;
    }

    downloadCsv(
      `assessment_ready_list_${localDateString()}.csv`,
      ['Name', 'Vendor', 'Type', 'Assessment Status', 'Attempts'],
      filteredProctors.map((p) => [
        p.name || '',
        p.vendor || '',
        p.ptype || '',
        'Ready',
        String(p.assessment_ready_attempt || 0),
      ])
    );
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Name, email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName="flex-1 min-w-[180px]"
        />
        {!isVendor && (
          <Select
            options={[
              { value: '', label: 'All Vendors' },
              ...vendorOptions,
            ]}
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            wrapperClassName="min-w-[160px]"
          />
        )}
        <Select
          options={[
            { value: '', label: 'All Types' },
            ...PROCTOR_TYPES.map(t => ({ value: t, label: t })),
          ]}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          wrapperClassName="min-w-[120px]"
        />
        <ClearFiltersButton
          show={!!(search || vendorFilter || typeFilter)}
          onClick={() => {
            setSearch('');
            setVendorFilter('');
            setTypeFilter('');
          }}
        />
        <Button variant="ghost" size="sm" onClick={exportReadyList}>
<Download className="w-3.5 h-3.5" /> Export Ready List
        </Button>
      </div>

      {/* Info Banner */}
      <div className="bg-info/10 border border-info/30 rounded-lg p-3 mb-4 text-xs text-info">
        Select one proctor from below, then configure and schedule their assessment.
      </div>

      {/* Table */}
      <div className="mb-4">
        <DataTable
          data={filteredProctors}
          isLoading={isLoading}
          emptyMessage="No proctors ready for assessment"
          columns={[
            {
              id: 'select',
              header: '',
              enableSorting: false,
              meta: { className: 'w-8' },
              cell: ({ row }) => (
                <input
                  type="radio"
                  name="assessProctor"
                  checked={selectedProctor === row.original.id}
                  onChange={() => setSelectedProctor(row.original.id)}
                  className="accent-accent"
                />
              ),
            },
            { id: 'name', header: 'Name', enableSorting: false, cell: ({ row }) => row.original.name, meta: { className: 'text-[13px] text-text font-semibold' } },
            { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-[12px] text-text2' } },
            {
              id: 'ptype',
              header: 'Type',
              enableSorting: false,
              cell: ({ row }) => (
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-info/10 text-info">
                  {row.original.ptype}
                </span>
              ),
            },
            {
              id: 'assessment_status',
              header: 'Assessment Status',
              enableSorting: false,
              cell: () => <span className="text-[11px] font-bold text-info">Ready</span>,
            },
            {
              id: 'attempts',
              header: 'Attempts',
              enableSorting: false,
              cell: ({ row }) => row.original.assessment_ready_attempt || 0,
              meta: { className: 'text-[12px] text-text3' },
            },
          ] satisfies ColumnDef<Proctor, any>[]}
        />
      </div>

      {/* Assignment Panel */}
      {selectedProctor && (
        <div className="bg-surface border-2 border-accent rounded-lg p-5 max-w-2xl">
          <div className="text-sm font-bold text-text mb-4">
            Schedule Assessment
          </div>
          {selectedProctorData && (
            <div className="text-xs text-text2 mb-4">
              Selected: <strong className="text-text">{selectedProctorData.name}</strong> · {selectedProctorData.vendor} · {selectedProctorData.ptype}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Panel (Coordinator) <span className="text-danger">*</span>
              </label>
              <Select
                options={[
                  { value: '', label: 'Select coordinator...' },
                  ...panelUsers.map((u) => ({ value: u, label: u })),
                ]}
                value={panelUser}
                onChange={(e) => setPanelUser(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Scheduled Date <span className="text-danger">*</span>
              </label>
              <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Scheduled Time <span className="text-danger">*</span>
              </label>
              <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                Score Out Of <span className="text-danger">*</span>
              </label>
              <Input type="number" min={1} placeholder="e.g. 100" value={scoreOutOf} onChange={(e) => setScoreOutOf(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => scheduleMutation.mutate()} disabled={scheduleMutation.isPending}>
              {scheduleMutation.isPending ? 'Scheduling...' : <><CheckCircle2 className="w-4 h-4" /> Schedule Assessment</>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BulkAssessment({ bulkAssessConfig, setBulkAssessConfig }: {
  bulkAssessConfig: BulkAssessConfig | null;
  setBulkAssessConfig: (cfg: BulkAssessConfig | null) => void;
}) {
  const { user } = useAuthStore();
  const [panelUser, setPanelUser] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [scoreOutOf, setScoreOutOf] = useState('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const { data: panelUsers = [] } = usePanelUsers();

  // Preview state -- selecting a file only ever parses/validates it into this; nothing
  // is scheduled until the admin explicitly clicks "Confirm & Schedule" below, mirroring
  // every other bulk-CSV flow in this app (Interview Selects import, AddProctorPage's
  // bulk upload). Uploading used to go straight from file-select to live scheduling
  // with no review step at all.
  const [csvRows, setCsvRows] = useState<Array<{
    email: string;
    proctor?: Proctor;
    name: string;
    vendor: string;
    ptype: string;
    _ok: boolean;
    _errors: string[];
  }> | null>(null);
  const [scheduling, setScheduling] = useState(false);

  // Shared with IndividualAssessment -- same filter/columns, one cache entry.
  const { data: proctors = [] } = useAssessmentReadyProctors();

  const downloadTemplate = () => {
    if (!panelUser || !scheduledDate || !scheduledTime || !scoreOutOf || Number(scoreOutOf) < 1) {
      showAlert('Select a Panel Coordinator, Scheduled Date, Time, and Score Out Of first', { tone: 'error' });
      return;
    }
    const ready = proctors;
    if (!ready.length) {
      showAlert('No proctors with Assessment Ready status', { tone: 'error' });
      return;
    }

    downloadCsv(
      `assessment_assign_${scheduledDate}.csv`,
      ['Email', 'Name', 'Vendor', 'Type'],
      ready.map((p) => [p.email || '', p.name || '', p.vendor || '', p.ptype || ''])
    );
    showAlert(`Downloaded ${ready.length} ready proctors. Delete rows you don't need, then upload the edited file back.`, { tone: 'success' });
    setBulkAssessConfig({
      panel: panelUser,
      date: scheduledDate,
      time: scheduledTime,
      score: Number(scoreOutOf),
    });
  };

  // Parses and validates the uploaded file into the preview below -- does not schedule
  // anything. That only happens if the admin reviews the table and clicks "Confirm &
  // Schedule".
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const cfg = bulkAssessConfig;
    if (!cfg?.panel || !cfg?.date) {
      showAlert('Download the Ready Proctors List first to set session config', { tone: 'error' });
      e.target.value = '';
      return;
    }

    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      showAlert('File appears empty', { tone: 'error' });
      e.target.value = '';
      return;
    }

    const header = parsed[0].map((h) => h.toLowerCase());
    const emailIdx = header.indexOf('email');
    if (emailIdx < 0) {
      showAlert('CSV must have an email column', { tone: 'error' });
      e.target.value = '';
      return;
    }

    // Tracks emails already seen earlier in this same file -- without this, two rows
    // for the same proctor both pass validation and both get scheduled concurrently
    // (runWithConcurrency has no per-proctor locking), producing two "attempt #1"
    // rows for one proctor in the same batch.
    const seenInFile = new Set<string>();

    const rows = parsed.slice(1).map((values) => {
      const email = values[emailIdx]?.trim().toLowerCase() || '';
      const proctor = proctors.find((p) => (p.email || '').toLowerCase() === email);
      const errors: string[] = [];
      if (!email) errors.push('Missing email');
      else if (seenInFile.has(email)) errors.push('Duplicate email in this file');
      else seenInFile.add(email);
      if (!proctor) errors.push('Proctor not found in portal');
      else if (proctor.assessment_ready !== 'ready') errors.push(`No longer in Ready status (${proctor.assessment_ready || 'unknown'})`);
      return { email, proctor, name: proctor?.name || '—', vendor: proctor?.vendor || '—', ptype: proctor?.ptype || '—', _ok: errors.length === 0, _errors: errors };
    }).filter((r) => r.email);

    if (!rows.length) {
      showAlert('No rows with an email found in that file', { tone: 'error' });
      e.target.value = '';
      return;
    }

    setCsvRows(rows);
    e.target.value = '';
  };

  const confirmSchedule = async () => {
    const cfg = bulkAssessConfig;
    if (!csvRows || !cfg?.panel || !cfg?.date) return;
    const validRows = csvRows.filter((r) => r._ok);
    if (!validRows.length) return;

    setScheduling(true);
    // One group_id shared by every candidate in this batch -- this is what makes the
    // upload a single group schedule (one shared session other coordinators/admins can
    // open as one unit in Workspace) rather than N unrelated individual schedules. Each
    // candidate still gets their own proctor_evaluations row/attempt/history; group_id
    // only ties them together as one session.
    const groupId = crypto.randomUUID();
    const results = await runWithConcurrency(validRows, 4, async (row) => {
      const { data: attempt, error: scheduleError } = await supabase.rpc('schedule_evaluation', {
        p_proctor_id: row.proctor!.id,
        p_eval_type: 'assessment',
        p_panel_user: cfg.panel,
        p_scheduled_date: cfg.date,
        p_scheduled_time: cfg.time,
        p_score_out_of: cfg.score,
        p_group_id: groupId,
      });
      if (scheduleError) throw scheduleError;

      await logAudit({
        action: 'Assessment Scheduled (Multi)',
        target: row.proctor!.name,
        detail: `Panel: ${cfg.panel} · Attempt ${attempt} · ${cfg.date} ${cfg.time} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    });
    setScheduling(false);

    // runWithConcurrency never throws on a per-row failure (unlike the Promise.all
    // this replaced), so failures have to be surfaced explicitly here instead of
    // relying on an uncaught rejection to skip the success message below.
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length === 0) {
      showAlert(`${succeeded} assessment(s) scheduled for ${cfg.panel}`, { tone: 'success' });
    } else {
      showAlert(
        `${succeeded} scheduled, ${failed.length} failed (e.g. ${failed[0].reason?.message || 'unknown error'})`,
        { tone: succeeded > 0 ? 'info' : 'error' }
      );
    }
    setCsvRows(null);
  };

  return (
    <div className="bg-surface border border-border rounded-lg p-6 max-w-3xl">
      <h3 className="text-sm font-semibold text-text uppercase tracking-wide mb-2">
        Step 1 — Configure Session
      </h3>
      <p className="text-text2 text-xs mb-4">
        Set the panel, date, time and score. Then download the pre-filled template with all Ready proctors and upload results.
      </p>
      
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-xs font-semibold text-text mb-1">
            Panel (Coordinator) <span className="text-danger">*</span>
          </label>
          <Select
            options={[
              { value: '', label: 'Select coordinator...' },
              ...panelUsers.map((u) => ({ value: u, label: u })),
            ]}
            value={panelUser}
            onChange={(e) => setPanelUser(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-text mb-1">
            Scheduled Date <span className="text-danger">*</span>
          </label>
          <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-text mb-1">
            Scheduled Time <span className="text-danger">*</span>
          </label>
          <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-text mb-1">
            Score Out Of <span className="text-danger">*</span>
          </label>
          <Input type="number" placeholder="e.g. 100" min={1} value={scoreOutOf} onChange={(e) => setScoreOutOf(e.target.value)} />
        </div>
      </div>

      <h3 className="text-sm font-semibold text-text uppercase tracking-wide mb-2">
        Step 2 — Download, Edit & Upload
      </h3>
      <p className="text-text2 text-xs mb-1">
        Download the full list of Assessment Ready proctors. <strong>Delete the rows you don't want to assign</strong>, keep only those for this session, then upload the edited file back.
      </p>
      <p className="text-text3 text-[11px] mb-3">
        Columns: <code className="bg-surface2 px-1.5 py-0.5 rounded text-[10px]">Email, Name, Vendor, Type</code> — do not add or rename columns.
      </p>

      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" size="sm" onClick={downloadTemplate}>
          <Download className="w-3.5 h-3.5" /> Download Ready Proctors List
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => uploadInputRef.current?.click()}
        >
          <Upload className="w-3.5 h-3.5" /> Upload Edited List
        </Button>
        <input
          ref={uploadInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={handleFileSelected}
        />
      </div>

      {csvRows && (
        <div className="mt-6 pt-6 border-t border-border">
          <h3 className="text-sm font-semibold text-text uppercase tracking-wide mb-2">
            Step 3 — Review &amp; Confirm
          </h3>
          <p className="text-text2 text-xs mb-3">
            {csvRows.filter((r) => r._ok).length} of {csvRows.length} row{csvRows.length === 1 ? '' : 's'} ready to
            schedule for <strong>{bulkAssessConfig?.panel}</strong> on {bulkAssessConfig?.date} {bulkAssessConfig?.time}.
            Nothing is scheduled until you confirm below.
          </p>
          <div className="mb-4">
            <DataTable
              data={csvRows}
              rowClassName={(r) => (r._ok ? '' : 'bg-danger/5')}
              columns={[
                { id: 'email', header: 'Email', enableSorting: false, cell: ({ row }) => row.original.email, meta: { className: 'text-text2' } },
                { id: 'name', header: 'Name', enableSorting: false, cell: ({ row }) => row.original.name, meta: { className: 'font-semibold text-text' } },
                { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-text2' } },
                { id: 'ptype', header: 'Type', enableSorting: false, cell: ({ row }) => row.original.ptype, meta: { className: 'text-text2' } },
                {
                  id: 'status',
                  header: 'Status',
                  enableSorting: false,
                  cell: ({ row }) => {
                    const r = row.original;
                    return r._ok ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-success">
                        <CheckCircle2 className="w-3 h-3" /> OK
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-danger" title={r._errors.join(', ')}>
                        <XCircle className="w-3 h-3" /> {r._errors[0]}
                      </span>
                    );
                  },
                },
              ] satisfies ColumnDef<typeof csvRows[number], any>[]}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={confirmSchedule}
              disabled={scheduling || csvRows.filter((r) => r._ok).length === 0}
            >
              {scheduling ? (
                'Scheduling...'
              ) : (
                <><CheckCircle2 className="w-3.5 h-3.5" /> Confirm &amp; Schedule {csvRows.filter((r) => r._ok).length}</>
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCsvRows(null)} disabled={scheduling}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultsTab() {
  const [subTab, setSubTab] = useState(0);

  return (
    <div>
      {/* Sub Tabs */}
      <div className="mb-4">
        <CompactSegmentedTabs
          options={[
            { label: 'Demo Results', value: 0, icon: Video },
            { label: 'Assessment Results', value: 1, icon: FileEdit },
          ]}
          value={subTab}
          onChange={setSubTab}
        />
      </div>

      {subTab === 0 ? <ResultsTable type="demo" /> : <ResultsTable type="assessment" />}
    </div>
  );
}

function ResultsTable({ type }: { type: 'demo' | 'assessment' }) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [overrideEvaluation, setOverrideEvaluation] = useState<any | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 25;
  const { data: vendorOptions = [] } = useVendorOptions();

  const isAdmin = user?.role === 'admin';
  const isVendor = user?.role === 'vendor';

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // One row per proctor's LATEST attempt for this eval_type, with earlier attempts
  // already nested as `history` -- both done server-side by the
  // latest_evaluation_per_proctor view (migration 0043/0044), so a candidate who
  // failed once and passed on retry still shows as one row, not two, and this can
  // now be paginated correctly (a plain client-side group-by over a full fetch
  // couldn't be, since a page boundary would split one proctor's attempts across
  // pages instead of splitting between proctors).
  const {
    data: pagedEvaluations,
    isLoading,
    isFetching,
    hasNextPage,
    hasPreviousPage,
    goToNextPage,
    goToPreviousPage,
    pageIndex,
  } = useCursorPaginatedQuery<any>({
    queryKey: ['evaluations-results', type, resultFilter, vendorFilter],
    table: 'latest_evaluation_per_proctor',
    filters: (q) => {
      let query = q.eq('eval_type', type);
      if (resultFilter) query = query.eq('result', resultFilter);
      if (vendorFilter) query = query.eq('proctor_vendor', vendorFilter);
      return query;
    },
    searchColumns: ['proctor_name', 'proctor_email'],
    searchTerm: debouncedSearch,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'created_at', ascending: false },
    resetKey: `${resultFilter}|${vendorFilter}`,
    // Narrowed from select('*') -- verified against every field ResultsTable and
    // OverrideModal actually read; proctor_id/group_id/created_by/status aren't used
    // anywhere in this tab.
    select: 'id, proctor_name, proctor_email, proctor_vendor, proctor_type, eval_type, panel_user, scheduled_date, scheduled_time, result, attempt_number, comment, score_obtained, score_out_of, certified_date, overridden_by, overridden_at, session_code, candidate_id, section_id, result_url, history',
  });

  const toggleHistory = (id: string) => {
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportResults = async () => {
    // Exports every matching row, not just the current page -- re-runs the same
    // filters against the view with no .range().
    let query = supabase.from('latest_evaluation_per_proctor').select('*').eq('eval_type', type).order('created_at', { ascending: false });
    if (resultFilter) query = query.eq('result', resultFilter);
    if (vendorFilter) query = query.eq('proctor_vendor', vendorFilter);
    if (debouncedSearch.trim()) {
      const term = debouncedSearch.trim();
      query = query.or(orIlikeFilter(['proctor_name', 'proctor_email'], term));
    }
    const { data, error } = await query;
    if (error) return showAlert('Failed to export: ' + error.message, { tone: 'error' });
    if (!data || data.length === 0) {
      showAlert(`No ${type} results to export`, { tone: 'error' });
      return;
    }

    downloadCsv(
      `eval_${type}_${localDateString()}.csv`,
      ['Proctor Name', 'Email', 'Vendor', 'Proctor Type', 'Eval Type', 'Panel', 'Scheduled Date', 'Attempt', 'Result', 'Comment', 'Certified Date'],
      (data as any[]).map((evaluation) => [
        evaluation.proctor_name || '—',
        evaluation.proctor_email || '—',
        evaluation.proctor_vendor || '—',
        evaluation.proctor_type || '—',
        evaluation.eval_type || '',
        evaluation.panel_user || '',
        evaluation.scheduled_date || '',
        evaluation.attempt_number || '',
        evaluation.result || '',
        evaluation.comment || '',
        evaluation.certified_date || '',
      ])
    );
  };

  const formatDateTime = (date?: string, time?: string) => {
    if (!date) return '—';
    const d = new Date(date);
    const dateStr = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
    return time ? `${dateStr} ${time}` : dateStr;
  };

  const getResultBadge = (result?: string, overriddenBy?: string, overriddenAt?: string) => {
    const colors: Record<string, string> = {
      'Pass': 'text-success',
      'Fail': 'text-danger',
      'Reattempt': 'text-warning',
      'No Show': 'text-text3',
      'Reschedule': 'text-warning',
    };
    const overriddenWhen = overriddenAt
      ? new Date(overriddenAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : null;
    return (
      <span className="flex items-center gap-1">
        <span className={`text-[12px] font-bold ${colors[result || ''] || 'text-text3'}`}>
          {result || '—'}
        </span>
        {overriddenBy && (
          <span
            className="inline-flex items-center gap-0.5 text-[10px] font-bold text-warning"
            title={overriddenWhen ? `Overridden by ${overriddenBy} on ${overriddenWhen}` : `Overridden by ${overriddenBy}`}
          >
            <AlertTriangle className="w-3 h-3" />OVR
          </span>
        )}
      </span>
    );
  };

  const handleOverride = (evaluation: any) => {
    setOverrideEvaluation(evaluation);
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Name, email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName="flex-1 min-w-[180px]"
        />
        <Select
          options={[
            { value: '', label: 'All Results' },
            { value: 'Pass', label: 'Pass' },
            { value: 'Reattempt', label: 'Reattempt' },
            { value: 'No Show', label: 'No Show' },
            { value: 'Reschedule', label: 'Reschedule' },
          ]}
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value)}
          wrapperClassName="min-w-[140px]"
        />
        {!isVendor && (
          <Select
            options={[
              { value: '', label: 'All Vendors' },
              ...vendorOptions,
            ]}
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            wrapperClassName="min-w-[160px]"
          />
        )}
        <ClearFiltersButton
          show={!!(search || resultFilter || vendorFilter)}
          onClick={() => {
            setSearch('');
            setResultFilter('');
            setVendorFilter('');
          }}
        />
        <Button variant="ghost" size="sm" onClick={exportResults}>
<Download className="w-3.5 h-3.5" /> Export
        </Button>
      </div>

      {/* Table */}
      <DataTable
        data={pagedEvaluations}
        isLoading={isLoading}
        // Non-admin has no action here (sees "Recorded", not an Override button --
        // see the actions column below), so the row itself is only clickable for
        // admin, same gating as the button it duplicates.
        onRowClick={isAdmin ? handleOverride : undefined}
        emptyMessage={`No ${type} results recorded yet`}
        pagination={{
          pageIndex,
          pageSize: PAGE_SIZE,
          hasNextPage,
          hasPreviousPage,
          isFetching,
          onNext: goToNextPage,
          onPrevious: goToPreviousPage,
        }}
        columns={[
          {
            id: 'proctor',
            header: 'Proctor',
            enableSorting: false,
            cell: ({ row }) => (
              <div>
                <div className="text-[13px] text-text font-semibold">{row.original.proctor_name}</div>
                <div className="text-[11px] text-text3">{row.original.proctor_vendor}</div>
              </div>
            ),
          },
          { id: 'panel', header: 'Panel', enableSorting: false, cell: ({ row }) => row.original.panel_user || '—', meta: { className: 'text-[12px] text-text2' } },
          {
            id: 'scheduled',
            header: 'Scheduled',
            enableSorting: false,
            cell: ({ row }) => formatDateTime(row.original.scheduled_date, row.original.scheduled_time),
            meta: { className: 'text-[12px] text-text3' },
          },
          {
            id: 'score',
            header: 'Score',
            enableSorting: false,
            cell: ({ row }) =>
              row.original.score_obtained != null
                ? `${row.original.score_obtained}${row.original.score_out_of ? '/' + row.original.score_out_of : ''}`
                : '—',
            meta: { className: 'font-display tabular-nums text-[12px] text-text2' },
          },
          {
            id: 'certified_date',
            header: 'Certified Date',
            enableSorting: false,
            cell: ({ row }) =>
              row.original.result === 'Pass'
                ? formatDateTime(row.original.certified_date || row.original.scheduled_date)
                : '—',
            meta: { className: 'text-[12px] text-success' },
          },
          {
            id: 'attempt',
            header: 'Attempt',
            enableSorting: false,
            cell: ({ row }) => {
              const evaluation = row.original;
              const history = evaluation.history || [];
              const hasHistory = history.length > 0;
              const isExpanded = expandedHistory.has(evaluation.id);
              return (
                <div className="flex items-center gap-1">
                  <span className="px-2 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-bold">
                    #{evaluation.attempt_number || 1}
                  </span>
                  {hasHistory && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleHistory(evaluation.id); }}
                      title={`${history.length} earlier attempt${history.length === 1 ? '' : 's'}`}
                      className="inline-flex items-center gap-0.5 text-text3 hover:text-accent text-[10px] font-semibold"
                    >
                      <History className="w-3 h-3" />
                      {history.length}
                      <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </div>
              );
            },
          },
          {
            id: 'result',
            header: 'Result',
            enableSorting: false,
            cell: ({ row }) => (
              <div className="flex items-center gap-1.5">
                {getResultBadge(row.original.result, row.original.overridden_by, row.original.overridden_at)}
                {row.original.result_url && (
                  <a
                    href={row.original.result_url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open evidence"
                    onClick={(e) => e.stopPropagation()}
                    className="text-text3 hover:text-accent"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            ),
          },
          {
            id: 'comment',
            header: 'Comment',
            enableSorting: false,
            cell: ({ row }) => row.original.comment || '—',
            meta: { className: 'text-[12px] text-text2 max-w-xs truncate' },
          },
          {
            id: 'actions',
            header: 'Actions',
            enableSorting: false,
            cell: ({ row }) =>
              isAdmin ? (
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleOverride(row.original); }}>
                  <RefreshCw className="w-3.5 h-3.5" /> Override
                </Button>
              ) : (
                <span className="text-text3 text-[11px]">Recorded</span>
              ),
          },
        ] satisfies ColumnDef<any, any>[]}
        renderExpandedRow={(evaluation) =>
          expandedHistory.has(evaluation.id) &&
          (evaluation.history || []).map((past: any) => (
            <tr key={past.id} className="border-b border-border bg-surface2/40">
              <td className="px-3.5 py-2 pl-8 text-[11px] text-text3 italic" colSpan={2}>
                Earlier attempt
              </td>
              <td className="px-3.5 py-2 text-[12px] text-text3">
                {formatDateTime(past.scheduled_date, past.scheduled_time)}
              </td>
              <td className="px-3.5 py-2 font-display tabular-nums text-[12px] text-text2">
                {past.score_obtained != null
                  ? `${past.score_obtained}${past.score_out_of ? '/' + past.score_out_of : ''}`
                  : '—'}
              </td>
              <td className="px-3.5 py-2 text-[12px] text-success">
                {past.result === 'Pass' ? formatDateTime(past.certified_date || past.scheduled_date) : '—'}
              </td>
              <td className="px-3.5 py-2">
                <span className="px-2 py-0.5 rounded bg-surface text-text3 text-[10px] font-bold">
                  #{past.attempt_number || 1}
                </span>
              </td>
              <td className="px-3.5 py-2">
                <div className="flex items-center gap-1.5">
                  {getResultBadge(past.result, past.overridden_by, past.overridden_at)}
                  {past.result_url && (
                    <a
                      href={past.result_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open evidence"
                      className="text-text3 hover:text-accent"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </td>
              <td className="px-3.5 py-2 text-[12px] text-text2 max-w-xs truncate">
                {past.comment || '—'}
              </td>
              <td className="px-3.5 py-2">
                {/* Superseded attempt -- not editable here. Overriding it would call the
                    same RPC that sets the proctor's live demo_ready/assessment_ready
                    status from whatever gets submitted, so "correcting" an old attempt
                    could silently stomp the status the current (latest) attempt set. */}
                <span className="text-text3 text-[11px]" title="Only the latest attempt can be overridden">
                  Superseded
                </span>
              </td>
            </tr>
          ))
        }
      />

      {/* Override Modal */}
      {overrideEvaluation && (
        <OverrideModal
          evaluation={overrideEvaluation}
          onClose={() => setOverrideEvaluation(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['evaluations-results'] });
            setOverrideEvaluation(null);
          }}
        />
      )}
    </div>
  );
}


interface OverrideModalProps {
  evaluation: any;
  onClose: () => void;
  onSuccess: () => void;
}

function OverrideModal({ evaluation, onClose, onSuccess }: OverrideModalProps) {
  const { user } = useAuthStore();
  const [result, setResult] = useState(evaluation.result || '');
  const [score, setScore] = useState(evaluation.score_obtained != null ? evaluation.score_obtained.toString() : '');
  const [reason, setReason] = useState(evaluation.comment || '');
  const [reasonOther, setReasonOther] = useState('');
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

  const reasonOptions = result ? [...(EVAL_REASON_OPTIONS_BY_RESULT[result] || []), 'Other'] : [];
  const comment = reason === 'Other' ? reasonOther : reason;

  const overrideMutation = useMutation({
    mutationFn: async () => {
      const newErrors: Record<string, string> = {};

      if (!result) newErrors.result = 'Result is required';
      if (!score || isNaN(Number(score))) newErrors.score = 'Score is required';
      else if (Number(score) < 0) newErrors.score = 'Score cannot be negative';
      else if (evaluation.score_out_of && Number(score) > evaluation.score_out_of) {
        newErrors.score = `Score cannot exceed ${evaluation.score_out_of}`;
      }
      if (['Reattempt', 'Reschedule'].includes(result) && !comment) {
        newErrors.comment = 'Reason is required for ' + result;
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

      const { error: evalError } = await supabase.rpc('submit_evaluation_result', {
        p_evaluation_id: evaluation.id,
        p_result: result,
        p_score: Number(score),
        p_comment: comment,
        p_session_code: evaluation.eval_type === 'demo' ? sessionCode.trim() : null,
        p_candidate_id: evaluation.eval_type !== 'demo' ? candidateId.trim() : null,
        p_section_id: evaluation.eval_type !== 'demo' ? sectionId.trim() : null,
      });

      if (evalError) throw evalError;

      // Note the before -> after values for the fields that can be corrected on a
      // resubmission, so the audit trail shows what changed, not just the new state.
      const isCorrection = !!evaluation.result;
      const fieldChange = (label: string, before: any, after: any) => {
        const b = before ?? '';
        const a = after ?? '';
        if (!isCorrection || b === a) return a ? ` · ${label}: ${a}` : '';
        return ` · ${label}: "${b || '(none)'}" -> "${a || '(none)'}"`;
      };
      const evidenceNote = evaluation.eval_type === 'demo'
        ? fieldChange('Session Code', evaluation.session_code, sessionCode)
        : fieldChange('Candidate ID', evaluation.candidate_id, candidateId) + fieldChange('Section ID', evaluation.section_id, sectionId);

      await logAudit({
        action: evaluation.result ? 'Eval Override' : 'Eval Result',
        target: evaluation.proctor_name,
        detail: `${evaluation.eval_type} Attempt #${evaluation.attempt_number}: ${result}${comment ? ` — ${comment}` : ''}${evidenceNote}${evaluation.result ? ` [overrides: ${evaluation.result}]` : ''} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    },
    onSuccess: () => {
      showAlert('Result overridden successfully', { tone: 'success' });
      onSuccess();
    },
    onError: (error: any) => {
      if (error.message !== 'Validation failed') {
        showAlert('Failed to override: ' + error.message, { tone: 'error' });
      }
    },
  });

  const formatDateTime = (date?: string, time?: string) => {
    if (!date) return '—';
    const d = new Date(date);
    const dateStr = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
    return time ? `${dateStr} ${time}` : dateStr;
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Override Result">
      <div className="space-y-4">
        {/* Info */}
        <div className="text-xs text-text2">
          <div>
            <strong>{evaluation.proctor_name}</strong> ({evaluation.proctor_vendor}) · {evaluation.eval_type} · 
            Panel: {evaluation.panel_user} · 
            Scheduled: {formatDateTime(evaluation.scheduled_date, evaluation.scheduled_time)} · 
            Attempt #{evaluation.attempt_number}
            {evaluation.score_out_of && ` · Score out of: ${evaluation.score_out_of}`}
          </div>
          {evaluation.result && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-2 mt-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Result already submitted as <strong>{evaluation.result}</strong>. Admin override will be logged.</span>
            </div>
          )}
        </div>

        {/* Form */}
        <div className="grid grid-cols-2 gap-4">
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
                setReason('');
                setReasonOther('');
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
              placeholder="Enter score..."
              min={0}
              max={evaluation.score_out_of || undefined}
              value={score}
              onChange={(e) => {
                setScore(e.target.value);
                setErrors({ ...errors, score: '' });
              }}
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
            Reason {['Reattempt', 'Reschedule'].includes(result) && <span className="text-danger">*</span>}
          </label>
          <Select
            options={[
              { value: '', label: 'Select reason...' },
              ...reasonOptions.map((r) => ({ value: r, label: r })),
            ]}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setErrors({ ...errors, comment: '' });
            }}
          />
          {reason === 'Other' && (
            <textarea
              value={reasonOther}
              onChange={(e) => {
                setReasonOther(e.target.value);
                setErrors({ ...errors, comment: '' });
              }}
              placeholder="Enter reason..."
              rows={3}
              className="w-full mt-2 px-3 py-2 bg-surface2 border border-border rounded-lg text-xs text-text outline-none focus:border-accent resize-none"
            />
          )}
          {errors.comment && <div className="text-danger text-xs mt-1">{errors.comment}</div>}
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => overrideMutation.mutate()}
            disabled={overrideMutation.isPending}
          >
            <Save className="w-4 h-4" /> Submit Evaluation
          </Button>
        </div>
      </div>
    </Modal>
  );
}
