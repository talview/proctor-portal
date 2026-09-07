import { useEffect, useState } from 'react';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { supabase } from '@/services/supabase';
import Table from '@/components/ui/Table';
import {
  FileEdit,
  Pencil,
  Paperclip,
  CheckCircle2,
  Target,
  LogOut,
  Key,
  LogIn,
  Send,
  Video,
  Users,
  BarChart3,
  Receipt,
  AlertTriangle,
  FileText,
  PenLine,
  Circle,
  Layers,
  RefreshCw,
  Download,
  type LucideIcon,
} from 'lucide-react';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import BulkActivityDrawer from '@/components/bulk/BulkActivityDrawer';
import { downloadCsv } from '@/lib/csv';
import { showAlert } from '@/components/ui/GlobalDialog';

interface AuditLog {
  id: string;
  ts: string;
  usr: string;
  action: string;
  target: string;
  detail: string;
  ref_id: string | null;
}

// The 4 bulk-action types below carry a ref_id (a bulk_dispatch_jobs.id) -- clicking one
// of these rows opens the same Bulk Activity drawer used elsewhere, drilled into that
// job's recipient-level results, rather than needing a separate log-only detail view.
const BULK_ACTION_TYPES = ['Bulk Send Initiated', 'Bulk Send Completed', 'Bulk Retry Triggered', 'Bulk Retry Completed'];

const ACTION_TYPES = [
  'Created',
  'Updated',
  'BGV Added',
  'Verified',
  'ID Assigned',
  'Offboarded',
  'Login',
  'Logout',
  'Eval Ready',
  'Form Link Shared',
  'Demo Scheduled',
  'Assessment Scheduled',
  'Assessment Scheduled (Multi)',
  'Assessment Result (CSV)',
  'Eval Result',
  'Eval Override',
  'NDA & Docs Triggered',
  'NDA Signed (Manual)',
  'BGV Uploaded',
  ...BULK_ACTION_TYPES,
];

const ACTION_ICONS: Record<string, LucideIcon> = {
  'Created': FileEdit,
  'Updated': Pencil,
  'BGV Added': Paperclip,
  'Verified': CheckCircle2,
  'ID Assigned': Target,
  'Offboarded': LogOut,
  'Login': Key,
  'Logout': LogIn,
  'Eval Ready': CheckCircle2,
  'Form Link Shared': Send,
  'Demo Scheduled': Video,
  'Assessment Scheduled': FileEdit,
  'Assessment Scheduled (Multi)': Users,
  'Assessment Result (CSV)': BarChart3,
  'Eval Result': Receipt,
  'Eval Override': AlertTriangle,
  'NDA & Docs Triggered': FileText,
  'NDA Signed (Manual)': PenLine,
  'BGV Uploaded': Paperclip,
  'Bulk Send Initiated': Layers,
  'Bulk Send Completed': Layers,
  'Bulk Retry Triggered': RefreshCw,
  'Bulk Retry Completed': RefreshCw,
};

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [page, setPage] = useState(1);
  const [activityJobId, setActivityJobId] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);

  // The on-screen table only ever queries the last 7 days -- a fixed, bounded
  // window regardless of how much history audit_log accumulates over time.
  // Anything further back is a deliberate export via "Download by date range"
  // below, not something paginated/browsed live in the UI.
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoIso = sevenDaysAgo.toISOString();

  // Debounce search so typing doesn't fire a request per keystroke now that
  // search is server-side instead of an instant client-side filter. Page reset
  // happens eagerly in the change handlers below (not in an effect keyed off
  // debouncedSearch) so it's applied in the same render as the input change --
  // otherwise there's a one-render window where the old page number pairs with
  // the new filter, which can request a .range() past the new (smaller) result
  // count and get back an HTTP 416 from PostgREST.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch audit logs -- server-side paginated and searched (was a flat top-500
  // fetch with client-side filtering; see migration 0032's era for context).
  const { data, isLoading, isFetching } = usePaginatedQuery<AuditLog>({
    queryKey: ['audit-logs', actionFilter],
    table: 'audit_log',
    filters: (q) => {
      let query = q.gte('ts', sevenDaysAgoIso);
      if (actionFilter) query = query.eq('action', actionFilter);
      return query;
    },
    searchColumns: ['target', 'usr'],
    searchTerm: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'ts', ascending: false },
    countMode: 'estimated',
  });

  const filteredLogs = data?.data ?? [];
  const count = data?.count ?? 0;

  const formatDateTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-IN', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const columns = [
    {
      header: 'Timestamp',
      accessor: (log: AuditLog) => formatDateTime(log.ts),
      className: 'font-mono text-[11px] text-text3 whitespace-nowrap',
    },
    {
      header: 'User',
      accessor: (log: AuditLog) => log.usr,
      className: 'font-semibold text-[13px] text-text',
    },
    {
      header: 'Action',
      accessor: (log: AuditLog) => {
        const ActionIcon = ACTION_ICONS[log.action] || Circle;
        return (
          <span className="inline-flex items-center gap-1.5">
            <ActionIcon className="w-3.5 h-3.5 text-text3" />
            {log.action}
          </span>
        );
      },
    },
    {
      header: 'Target',
      accessor: (log: AuditLog) => log.target,
    },
    {
      header: 'Details',
      accessor: (log: AuditLog) => log.detail,
      className: 'text-[12px] text-text3',
    },
  ];

  return (
    <div>
      {/* Filters */}
      <div className="bg-surface border border-border rounded-lg p-4 mb-4 flex gap-2 items-center flex-wrap">
        <Input
          placeholder="Search..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          wrapperClassName="flex-1 min-w-[180px]"
        />
        <Select
          options={[
            { value: '', label: 'All Actions' },
            ...ACTION_TYPES.map((action) => ({ value: action, label: action })),
          ]}
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setPage(1);
          }}
          wrapperClassName="min-w-[140px]"
        />
        <ClearFiltersButton
          show={!!(search || actionFilter)}
          onClick={() => {
            setSearch('');
            setActionFilter('');
            setPage(1);
          }}
        />
        <span className="text-xs text-text2 whitespace-nowrap ml-auto">
          {count} entries · last 7 days
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowDownloadModal(true)}>
          <Download className="w-3.5 h-3.5" /> Download by date range
        </Button>
      </div>

      <Table
        data={filteredLogs}
        columns={columns}
        isLoading={isLoading}
        emptyMessage="No entries yet"
        pagination={{ page, pageSize: PAGE_SIZE, count, isFetching, onPageChange: setPage }}
        onRowClick={(log) => {
          if (BULK_ACTION_TYPES.includes(log.action) && log.ref_id) setActivityJobId(log.ref_id);
        }}
      />

      <BulkActivityDrawer
        isOpen={!!activityJobId}
        onClose={() => setActivityJobId(null)}
        initialJobId={activityJobId}
      />

      {showDownloadModal && <DownloadRangeModal onClose={() => setShowDownloadModal(false)} />}
    </div>
  );
}

/** The escape hatch for anything older than the on-screen table's fixed 7-day
 * window -- an admin picks a date range and gets a CSV rather than paginating
 * through history live. Unbounded query (no .range()) for the picked range,
 * mirroring the same export-at-click-time pattern already used by
 * CertificationsPage/EvaluationsPage/OffboardedPage. */
function DownloadRangeModal({ onClose }: { onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const [from, setFrom] = useState(sevenDaysAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);

  const handleDownload = async () => {
    if (!from || !to) return showAlert('Both dates are required', { tone: 'error' });
    if (from > to) return showAlert('From date must be before the To date', { tone: 'error' });

    setBusy(true);
    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .gte('ts', `${from}T00:00:00.000Z`)
        .lte('ts', `${to}T23:59:59.999Z`)
        .order('ts', { ascending: true });
      if (error) throw error;

      const rows = (data || []) as AuditLog[];
      if (rows.length === 0) {
        showAlert('No audit log entries found in that date range', { tone: 'info' });
        return;
      }

      downloadCsv(
        `audit_log_${from}_to_${to}.csv`,
        ['Timestamp', 'User', 'Action', 'Target', 'Details'],
        rows.map((log) => [new Date(log.ts).toISOString(), log.usr, log.action, log.target, log.detail])
      );
      onClose();
    } catch (err: any) {
      showAlert('Failed to download: ' + err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Download Audit Log by Date Range">
      <div className="space-y-4">
        <p className="text-[12px] text-text3">
          Exports every matching entry for the selected range as a CSV -- not limited to the
          7 days shown on screen.
        </p>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-[12px] font-semibold text-text mb-1">From</label>
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex-1">
            <label className="block text-[12px] font-semibold text-text mb-1">To</label>
            <Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleDownload} disabled={busy}>
            <Download className="w-3.5 h-3.5" /> {busy ? 'Preparing…' : 'Download CSV'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
