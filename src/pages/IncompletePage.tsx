import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Paperclip, Upload, XCircle, Loader2, FileText, RefreshCw } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import Table from '@/components/ui/Table';
import { proctorService } from '@/services/proctor';
import { logAudit } from '@/services/audit';
import { getScopedVendor } from '@/utils/access';
import { useManagedByOptions } from '@/hooks/useManagedByOptions';
import { showAlert } from '@/components/ui/GlobalDialog';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import { DOCUMENT_FORMAT_HINT, prepareDocumentFile, runWithConcurrency } from '@/utils/documentUpload';
import type { Proctor } from '@/types';

/** Minimal shape BulkBgvUploadModal needs to match an uploaded file to a proctor by
 * PID -- it fetches this itself for every proctor in the system (see the
 * `incomplete-bgv-all-for-match` query below), independent of the main list's
 * pagination/search/tab filters. */
type BulkMatchProctor = Pick<Proctor, 'id' | 'pid' | 'name' | 'email' | 'managed_by' | 'vendor'>;

// Concurrent BGV uploads in flight at once during a bulk upload -- was a strictly
// sequential upload -> RPC -> audit loop before, one file fully completing before the
// next started.
const BULK_UPLOAD_CONCURRENCY = 4;

export default function IncompletePage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [uploadProctor, setUploadProctor] = useState<Proctor | null>(null);
  const [bgvFile, setBgvFile] = useState<File | null>(null);
  const [bgvFileError, setBgvFileError] = useState('');
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bgvFilter, setBgvFilter] = useState<'pending' | 'uploaded'>('pending');
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const PAGE_SIZE = 25;

  const isVendor = user?.role === 'vendor';
  const scopedVendor = getScopedVendor(user);
  const { data: managedByOptions = [] } = useManagedByOptions();

  // Debounce search so typing doesn't fire a request per keystroke now that search is
  // server-side instead of an instant client-side filter (mirrors ProctorsPage/AuditLogPage).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // BGV only becomes collectible once a proctor is Active -- before that there's
  // nothing to chase yet, so "pending" is scoped to Active proctors only. "Uploaded"
  // is any status with a non-empty bgv on file. (Previously a client-side
  // `bgvUploaded` predicate; now expressed directly as `.or('bgv.is.null,bgv.eq.')` /
  // `.not('bgv','is',null).neq('bgv','')` server-side below.)

  // Server-side paginated + searched (was a flat fetch-everything-then-filter, see
  // migration history for context). Vendor scoping, the status/vendor filters, and the
  // Pending/Uploaded tab all move into the query itself.
  const { data: pageResult, isLoading, isFetching } = usePaginatedQuery<Proctor>({
    queryKey: ['incomplete-bgv', scopedVendor, bgvFilter, statusFilter, vendorFilter],
    table: 'proctors',
    filters: (q) => {
      let query = q.neq('status', 'Archived').neq('status', 'Interview Selected');
      // Vendor sees only their proctors.
      if (scopedVendor) query = query.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
      if (statusFilter) query = query.eq('status', statusFilter);
      // `vendor` in this list is really `managed_by || vendor` (normalized below), so
      // the vendor filter has to check both underlying columns.
      if (vendorFilter) query = query.or(`managed_by.eq.${vendorFilter},vendor.eq.${vendorFilter}`);
      // Pending: Active proctors with no bgv on file (null or empty string).
      // Uploaded: any proctor with a non-empty bgv on file.
      if (bgvFilter === 'pending') {
        query = query.eq('status', 'Active').or('bgv.is.null,bgv.eq.');
      } else {
        query = query.not('bgv', 'is', null).neq('bgv', '');
      }
      return query;
    },
    // Vendor isn't its own real column value here -- it's managed_by||vendor -- so
    // both underlying columns are searched alongside name.
    searchColumns: ['name', 'managed_by', 'vendor'],
    searchTerm: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'at', ascending: true },
  });

  const totalCount = pageResult?.count ?? 0;
  const normalizedPage = (pageResult?.data ?? []).map((p) => ({ ...p, vendor: p.managed_by || p.vendor || '' }));

  // Tab-count badges can no longer be derived from a single page's worth of rows --
  // each gets its own lightweight count-only query, vendor-scoped the same way the
  // main list is, but (matching the old behavior, which counted over the full
  // vendor-scoped list before the tab/status/vendor/search filters were applied)
  // NOT narrowed by the currently selected tab/status/vendor/search filters.
  const { data: pendingCount = 0 } = useQuery({
    queryKey: ['incomplete-bgv-count', 'pending', scopedVendor],
    queryFn: async () => {
      let q = supabase
        .from('proctors')
        .select('*', { count: 'exact', head: true })
        .neq('status', 'Archived')
        .neq('status', 'Interview Selected')
        .eq('status', 'Active')
        .or('bgv.is.null,bgv.eq.');
      if (scopedVendor) q = q.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    },
  });

  const { data: uploadedCount = 0 } = useQuery({
    queryKey: ['incomplete-bgv-count', 'uploaded', scopedVendor],
    queryFn: async () => {
      let q = supabase
        .from('proctors')
        .select('*', { count: 'exact', head: true })
        .neq('status', 'Archived')
        .neq('status', 'Interview Selected')
        .not('bgv', 'is', null)
        .neq('bgv', '');
      if (scopedVendor) q = q.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    },
  });

  // BulkBgvUploadModal matches uploaded files to proctors by PID -- it needs to match
  // against every proctor in the system, not just whatever page/filter/tab is
  // currently on screen, so it gets its own dedicated fetch (only ever the lean set
  // of columns it actually needs) instead of depending on the paginated page above.
  // Only fetched once the modal is actually open.
  const { data: allProctorsForBulkMatch = [] } = useQuery({
    queryKey: ['incomplete-bgv-all-for-match', scopedVendor],
    queryFn: async () => {
      let q = supabase
        .from('proctors')
        .select('id, pid, name, email, managed_by, vendor')
        .neq('status', 'Archived')
        .neq('status', 'Interview Selected');
      if (scopedVendor) q = q.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
      const { data, error } = await q;
      if (error) throw error;
      return (data as BulkMatchProctor[]).map((p) => ({ ...p, vendor: p.managed_by || p.vendor || '' }));
    },
    enabled: showBulkUpload,
  });

  // Calculate BGV due info -- the countdown starts from activation (aat), not from
  // when the proctor record was first created.
  const BGV_DUE_DAYS = 12;

  const getBgvDueInfo = (proctor: Proctor) => {
    if (!proctor.aat) return { label: '—', color: 'text-text3', days: 0 };

    const submitted = new Date(proctor.aat);
    const dueDate = new Date(submitted.getTime() + BGV_DUE_DAYS * 24 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    
    if (diff > 0) {
      return {
        label: `Due in ${diff}d`,
        color: diff <= 3 ? 'text-warning' : 'text-success',
        bgColor: diff <= 3 ? 'bg-warning/15' : 'bg-success/10',
        days: diff
      };
    } else {
      return {
        label: `${Math.abs(diff)}d overdue`,
        color: 'text-danger',
        bgColor: 'bg-danger/15',
        days: diff
      };
    }
  };

  // Sort by status priority (Active first, then Verified, In Progress, Offboarded).
  // NOTE -- pagination tradeoff: usePaginatedQuery's `orderBy` only takes one real
  // column (PostgREST/.order() doesn't support a CASE-based priority expression), so
  // this status-priority ordering can't be applied server-side across the whole
  // result set before it's split into pages. Rather than add a DB column or view
  // just for this one page's cosmetic grouping, this sorts only the rows already on
  // the current page (fetched in `at` order, see orderBy above) -- each page still
  // looks correctly grouped by status internally, but a page boundary can now split
  // two same-status rows that would have been adjacent under the old full-list sort.
  const statusOrder: Record<string, number> = {
    'Active': 0,
    'Verified': 1,
    'In Progress': 2,
    'Offboarded': 3
  };

  const sortedProctors = [...normalizedPage].sort((a, b) => {
    return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
  });

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      'Active': 'bg-success/10 text-success',
      'In Progress': 'bg-warning/10 text-warning',
      'Verified': 'bg-info/10 text-info',
      'Offboarded': 'bg-danger/10 text-danger',
    };
    return (
      <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${colors[status] || 'bg-text3/10 text-text3'}`}>
        {status}
      </span>
    );
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadProctor) throw new Error('No proctor selected');
      if (!bgvFile) throw new Error('Please choose a BGV file');

      const safeEmail = (uploadProctor.email || uploadProctor.id).replace(/[^a-z0-9]/gi, '_');
      const path = `${safeEmail}_bgv_${Date.now()}`;
      const url = await proctorService.uploadFile('bgv-documents', path, bgvFile);

      const { error } = await supabase.rpc('submit_bgv', {
        p_proctor_id: uploadProctor.id,
        p_file_url: url,
      });

      if (error) throw error;

      await logAudit({
        action: 'BGV Uploaded',
        target: uploadProctor.name,
        detail: `File uploaded to storage by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    },
    onSuccess: async () => {
      // Prefix-match (no exact filter/page suffix) so every bgvFilter/status/vendor/page/
      // search variant of the paginated query, both count badges, and the bulk-match
      // fetch all get invalidated together.
      await queryClient.invalidateQueries({ queryKey: ['incomplete-bgv'] });
      await queryClient.invalidateQueries({ queryKey: ['incomplete-bgv-count'] });
      await queryClient.invalidateQueries({ queryKey: ['incomplete-bgv-all-for-match'] });
      await queryClient.invalidateQueries({ queryKey: ['proctors'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setUploadProctor(null);
      setBgvFile(null);
      setBgvFileError('');
      showAlert('BGV uploaded successfully', { tone: 'success' });
    },
    onError: (error: any) => {
      showAlert('BGV upload failed: ' + error.message, { tone: 'error' });
    },
  });

  const bgvColumns = [
    {
      header: 'Name',
      accessor: (row: Proctor) => (
        <div>
          <div className="font-semibold text-text">{row.name}</div>
          {row.pid && <div className="font-mono text-[11px] text-text3">{row.pid}</div>}
        </div>
      ),
    },
    {
      header: 'Vendor / Type',
      accessor: (row: Proctor) => (
        <span className="text-[12px] text-text2 font-medium">
          {row.vendor || '—'}
          {row.vendor && row.ptype && <span className="text-text3 mx-1">|</span>}
          {row.ptype}
        </span>
      ),
    },
    { header: 'Status', accessor: (row: Proctor) => getStatusBadge(row.status) },
    {
      header: bgvFilter === 'pending' ? 'Activated' : 'Added',
      accessor: (row: Proctor) => (
        <span className="text-xs text-text2">{formatDate(bgvFilter === 'pending' ? row.aat! : row.at)}</span>
      ),
    },
    {
      header: bgvFilter === 'pending' ? 'Due' : 'Document',
      accessor: (row: Proctor) => {
        if (bgvFilter === 'uploaded') {
          return (
            <button
              className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
              onClick={() => window.open(row.bgv!, '_blank', 'noopener,noreferrer')}
            >
              <FileText className="w-3.5 h-3.5" /> View Document
            </button>
          );
        }
        const dueInfo = getBgvDueInfo(row);
        return (
          <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded ${dueInfo.bgColor} ${dueInfo.color}`}>
            <Clock className="w-3.5 h-3.5" /> {dueInfo.label}
          </span>
        );
      },
    },
    {
      header: 'Action',
      accessor: (row: Proctor) => {
        if (bgvFilter === 'uploaded') {
          return row.status === 'Active' ? (
            <Button variant="ghost" size="sm" onClick={() => setUploadProctor(row)} className="!text-[11px] !px-2 !py-1">
              <Paperclip className="w-3.5 h-3.5" /> Replace
            </Button>
          ) : null;
        }
        // This tab is already scoped to Active proctors -- BGV isn't collectible
        // before activation.
        return (
          <Button variant="primary" size="sm" onClick={() => setUploadProctor(row)} className="!text-[11px] !px-2 !py-1">
            <Paperclip className="w-3.5 h-3.5" /> Upload BGV
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      {/* Filters */}
      <div className="mb-4">
        <UnderlineTabs
          options={[
            { label: `Pending (${pendingCount})`, value: 'pending', icon: Clock },
            { label: `Uploaded (${uploadedCount})`, value: 'uploaded', icon: CheckCircle2 },
          ]}
          value={bgvFilter}
          onChange={(v) => {
            setBgvFilter(v);
            setPage(1);
          }}
        />
      </div>
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Search name..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          wrapperClassName="flex-1 min-w-[180px]"
        />
        <Select
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'In Progress', label: 'In Progress' },
            { value: 'Verified', label: 'Verified' },
            { value: 'Active', label: 'Active' },
            { value: 'Offboarded', label: 'Offboarded' },
          ]}
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          wrapperClassName="min-w-[140px]"
        />
        {!isVendor && (
          <Select
            options={[
              { value: '', label: 'All Vendors' },
              ...managedByOptions,
            ]}
            value={vendorFilter}
            onChange={(e) => {
              setVendorFilter(e.target.value);
              setPage(1);
            }}
            wrapperClassName="min-w-[160px]"
          />
        )}
        <ClearFiltersButton
          show={!!(search || statusFilter || vendorFilter)}
          onClick={() => {
            setSearch('');
            setStatusFilter('');
            setVendorFilter('');
            setPage(1);
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => setShowBulkUpload(true)} className="ml-auto">
          <Upload className="w-3.5 h-3.5" /> Bulk Upload BGV
        </Button>
      </div>

      {/* Grid */}
      {bgvFilter === 'pending' && !isLoading && totalCount === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text mb-2">All complete!</h3>
          <p className="text-text3 text-sm">
            No proctors with missing BGV documents.
          </p>
        </div>
      ) : (
        <Table
          data={sortedProctors}
          columns={bgvColumns}
          isLoading={isLoading}
          emptyMessage={bgvFilter === 'uploaded' ? 'No BGV documents uploaded yet' : 'No proctors with missing BGV documents'}
          pagination={{ page, pageSize: PAGE_SIZE, count: totalCount, isFetching, onPageChange: setPage }}
        />
      )}
      {uploadProctor && (
        <Modal
          isOpen={true}
          onClose={() => {
            setUploadProctor(null);
            setBgvFile(null);
          }}
          title="Upload BGV Document"
          size="md"
        >
          <div className="space-y-4">
            <div className="bg-info/10 border border-info/30 rounded-lg p-3 text-info text-sm">
              Upload the BGV file for <strong>{uploadProctor.name}</strong>. The file will be stored in Supabase Storage.
            </div>
            <div>
              <label className="block text-xs font-semibold text-text mb-1">
                BGV Document <span className="text-danger">*</span>
              </label>
              <p className="text-[11px] text-text3 mb-1.5">{DOCUMENT_FORMAT_HINT}</p>
              <Input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={async (e) => {
                  const rawFile = e.target.files?.[0] || null;
                  setBgvFileError('');
                  if (!rawFile) {
                    setBgvFile(null);
                    return;
                  }
                  const { file, error } = await prepareDocumentFile(rawFile);
                  if (error || !file) {
                    setBgvFile(null);
                    setBgvFileError(error || 'Invalid file');
                    e.target.value = '';
                    return;
                  }
                  setBgvFile(file);
                }}
              />
              {bgvFileError && <p className="text-[11px] text-danger mt-1">{bgvFileError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="ghost"
                onClick={() => {
                  setUploadProctor(null);
                  setBgvFile(null);
                  setBgvFileError('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => uploadMutation.mutate()}
                disabled={uploadMutation.isPending || !bgvFile}
              >
                {uploadMutation.isPending ? 'Uploading...' : <><Paperclip className="w-4 h-4" /> Upload BGV</>}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showBulkUpload && (
        <BulkBgvUploadModal
          proctors={allProctorsForBulkMatch}
          onClose={() => setShowBulkUpload(false)}
          onDone={() => {
            setShowBulkUpload(false);
            queryClient.invalidateQueries({ queryKey: ['incomplete-bgv'] });
            queryClient.invalidateQueries({ queryKey: ['incomplete-bgv-count'] });
            queryClient.invalidateQueries({ queryKey: ['incomplete-bgv-all-for-match'] });
            queryClient.invalidateQueries({ queryKey: ['proctors'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
          }}
          username={user?.username || user?.name || null}
        />
      )}
    </div>
  );
}

interface MatchedFile {
  file: File;
  matchedProctor: BulkMatchProctor | null;
  validationError: string | null;
}

type UploadOutcome = { status: 'success' } | { status: 'failed'; error: string };

function BulkBgvUploadModal({
  proctors,
  onClose,
  onDone,
  username,
}: {
  proctors: BulkMatchProctor[];
  onClose: () => void;
  onDone: () => void;
  username: string | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState<MatchedFile[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, UploadOutcome>>({});
  const [error, setError] = useState('');

  const proctorsByPid = new Map(proctors.filter((p) => p.pid).map((p) => [p.pid!.toLowerCase(), p]));

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    setError('');
    setOutcomes({});
    // Validated (format + 3MB limit, compressing an oversized image where possible)
    // up front -- an invalid file is flagged here and never attempted, rather than
    // being uploaded and rejected afterward.
    const matched = await Promise.all(
      files.map(async (rawFile) => {
        const baseName = rawFile.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
        const matchedProctor = proctorsByPid.get(baseName) || null;
        const { file, error: validationError } = await prepareDocumentFile(rawFile);
        return { file: file || rawFile, matchedProctor, validationError };
      })
    );
    setMatches(matched);
  };

  const toUpload = matches.filter((m) => m.matchedProctor && !m.validationError);
  const matchedCount = toUpload.length;

  const uploadOne = async (m: MatchedFile, attemptIndex: number) => {
    const proctor = m.matchedProctor!;
    const safeEmail = (proctor.email || proctor.id).replace(/[^a-z0-9]/gi, '_');
    const path = `${safeEmail}_bgv_${Date.now()}_${attemptIndex}`;
    const url = await proctorService.uploadFile('bgv-documents', path, m.file);

    const { error: rpcError } = await supabase.rpc('submit_bgv', {
      p_proctor_id: proctor.id,
      p_file_url: url,
    });
    if (rpcError) throw rpcError;

    await logAudit({
      action: 'BGV Uploaded',
      target: proctor.name,
      detail: `Bulk-uploaded to storage by ${username || 'system'}`,
      user: username,
    });
  };

  // Concurrency-limited (not one-file-at-a-time): each file's own upload -> RPC -> audit
  // sequence still happens in order for that file, but up to BULK_UPLOAD_CONCURRENCY
  // files are in flight at once. One file's failure is captured per-item and never
  // stops the rest (mirrors Promise.allSettled semantics -- see runWithConcurrency).
  const runUploads = async (items: MatchedFile[]) => {
    setProgress({ done: 0, total: items.length });
    let done = 0;
    await runWithConcurrency(items, BULK_UPLOAD_CONCURRENCY, async (m, i) => {
      try {
        await uploadOne(m, i);
        setOutcomes((prev) => ({ ...prev, [m.matchedProctor!.id]: { status: 'success' } }));
      } catch (err: any) {
        setOutcomes((prev) => ({ ...prev, [m.matchedProctor!.id]: { status: 'failed', error: err.message || 'Upload failed' } }));
      } finally {
        done++;
        setProgress({ done, total: items.length });
      }
    });
    setProgress(null);
  };

  // outcomes is updated via setState inside runUploads, so counts below are read
  // straight from state at render time rather than computed inside runUploads itself.
  const attemptedIds = new Set(toUpload.map((m) => m.matchedProctor!.id));
  const succeededCount = [...attemptedIds].filter((id) => outcomes[id]?.status === 'success').length;
  const failedIds = [...attemptedIds].filter((id) => outcomes[id]?.status === 'failed');
  const hasRunOnce = Object.keys(outcomes).length > 0;

  const handleConfirm = async () => {
    if (toUpload.length === 0) return showAlert('No files matched a Proctor ID', { tone: 'error' });
    await runUploads(toUpload);
  };

  const handleRetryFailed = async () => {
    const retryItems = toUpload.filter((m) => failedIds.includes(m.matchedProctor!.id));
    if (retryItems.length === 0) return;
    await runUploads(retryItems);
  };

  useEffect(() => {
    if (!hasRunOnce || progress) return;
    if (failedIds.length > 0) {
      setError(`${succeededCount} uploaded, ${failedIds.length} failed. Use "Retry Failed" below.`);
    } else {
      setError('');
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunOnce, progress, failedIds.length, succeededCount]);

  return (
    <Modal isOpen={true} onClose={onClose} title="Bulk Upload BGV Documents" size="lg">
      <div className="space-y-4">
        <p className="text-text2 text-xs">
          Select multiple BGV files at once. Each file must be named after the proctor's ID (e.g.{' '}
          <code className="bg-surface2 px-1.5 py-0.5 rounded text-[10px]">PID1023.pdf</code>) so it can be matched automatically.
          {' '}{DOCUMENT_FORMAT_HINT}
        </p>

        {error && (
          <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 text-xs font-semibold">
            {error}
          </div>
        )}

        <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-accent/50 transition-colors">
          <Upload className="w-7 h-7 text-text3 mb-2" />
          <p className="text-sm text-text2">
            <span className="text-accent font-semibold">Click to select files</span> or drag and drop
          </p>
          <p className="text-xs text-text3 mt-1">PDF, JPG or PNG files, named by Proctor ID</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
          />
        </label>

        {matches.length > 0 && (
          <Table
            data={matches}
            columns={[
              { header: 'File', accessor: (m) => m.file.name, className: 'text-text2 font-mono' },
              { header: 'Matched Proctor', accessor: (m) => m.matchedProctor?.name || '—', className: 'text-text' },
              {
                header: 'Status',
                accessor: (m) => {
                  const outcome = m.matchedProctor ? outcomes[m.matchedProctor.id] : undefined;
                  if (outcome?.status === 'success') {
                    return (
                      <span className="inline-flex items-center gap-1 text-success font-bold">
                        <CheckCircle2 className="w-3 h-3" /> Uploaded
                      </span>
                    );
                  }
                  if (outcome?.status === 'failed') {
                    return (
                      <span className="inline-flex items-center gap-1 text-danger font-bold" title={outcome.error}>
                        <XCircle className="w-3 h-3" /> Failed: {outcome.error}
                      </span>
                    );
                  }
                  if (m.validationError) {
                    return (
                      <span className="inline-flex items-center gap-1 text-danger font-bold" title={m.validationError}>
                        <XCircle className="w-3 h-3" /> {m.validationError}
                      </span>
                    );
                  }
                  return m.matchedProctor ? (
                    <span className="inline-flex items-center gap-1 text-success font-bold">
                      <CheckCircle2 className="w-3 h-3" /> Matched
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-danger font-bold">
                      <XCircle className="w-3 h-3" /> No match
                    </span>
                  );
                },
              },
            ]}
          />
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {hasRunOnce && failedIds.length > 0 && !progress && (
            <Button variant="ghost" onClick={handleRetryFailed}>
              <RefreshCw className="w-4 h-4" /> Retry Failed ({failedIds.length})
            </Button>
          )}
          <Button variant="primary" onClick={handleConfirm} disabled={matchedCount === 0 || !!progress}>
            {progress ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Uploading {progress.done}/{progress.total}
              </>
            ) : (
              `Upload ${matchedCount} Matched File${matchedCount === 1 ? '' : 's'}`
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
