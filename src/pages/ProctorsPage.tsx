import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2 } from 'lucide-react';
import { supabase, invokeEdgeFunction } from '@/services/supabase';
import { proctorService } from '@/services/proctor';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useFormState } from '@/hooks/useFormState';
import Table from '@/components/ui/Table';
import FormSection from '@/components/ui/FormSection';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import ActionMenu from '@/components/ui/ActionMenu';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import { logAudit } from '@/services/audit';
import { formatDate, exportToCSV, aadhaarStatus, formatPhone } from '@/utils/formatters';
import { useManagedByOptions } from '@/hooks/useManagedByOptions';
import { useAuthStore } from '@/stores/auth';
import { PROCTOR_TYPES } from '@/utils/constants';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import BulkActivityDrawer from '@/components/bulk/BulkActivityDrawer';
import { createBulkDispatch, getActiveDispatchForProctors } from '@/services/bulkDispatch';
import type { Proctor, ProctorFilters } from '@/types';

export default function ProctorsPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ProctorFilters>({
    search: '',
    vendor: '',
    status: '',
    ptype: '',
    docsStatus: '',
  });
  const [selectedProctor, setSelectedProctor] = useState<Proctor | null>(null);
  const [editingProctor, setEditingProctor] = useState<Proctor | null>(null);
  const [offboardingProctor, setOffboardingProctor] = useState<Proctor | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ text: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [activityDrawer, setActivityDrawer] = useState<{ open: boolean; jobId: string | null }>({ open: false, jobId: null });
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search || '');
  const { data: managedByOptions = [] } = useManagedByOptions();

  const isAdmin = user?.role === 'admin';
  const isVendor = user?.role === 'vendor';

  // Generous page size -- at today's real data volume (tens of rows) this keeps
  // the table showing everything in one page, same as before pagination existed;
  // it only starts actually paging once a filtered result set grows past it.
  const PAGE_SIZE = 100;

  // Debounce search so typing doesn't fire a request per keystroke now that
  // search is server-side instead of an instant client-side filter.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search || ''), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  // RLS already scopes vendor rows to their own vendor at the database level.
  const { data: pageResult, isLoading, isFetching } = usePaginatedQuery<Proctor>({
    queryKey: ['proctors', filters.vendor, filters.status, filters.ptype, filters.docsStatus],
    table: 'proctors',
    filters: (q) => {
      // Archived rows are re-onboarding history (Offboarded & History page);
      // interview_selected candidates haven't submitted the form yet (Interview
      // Selects page) -- neither belongs in this list, matching proctorService.getAll.
      let query = q.neq('status', 'Archived').neq('interview_stage', 'interview_selected');
      if (filters.vendor) query = query.eq('managed_by', filters.vendor);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.ptype) query = query.eq('ptype', filters.ptype);
      // Mirrors the Documents column's own badge logic (isNdaLinkExpired below) --
      // "expired" isn't a stored value, it's final_form_status:'sent' whose
      // nda_link_expires_at has passed.
      if (filters.docsStatus) {
        const nowIso = new Date().toISOString();
        if (filters.docsStatus === 'not_started') {
          query = query.or('final_form_status.is.null,final_form_status.eq.');
        } else if (filters.docsStatus === 'pending') {
          query = query.eq('final_form_status', 'sent').or(`nda_link_expires_at.is.null,nda_link_expires_at.gte.${nowIso}`);
        } else if (filters.docsStatus === 'expired') {
          query = query.eq('final_form_status', 'sent').lt('nda_link_expires_at', nowIso);
        } else if (filters.docsStatus === 'submitted') {
          query = query.eq('final_form_status', 'submitted');
        }
      }
      return query;
    },
    searchColumns: ['name', 'email', 'phone', 'pid'],
    searchTerm: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'at', ascending: false },
  });

  const proctors = pageResult?.data ?? [];
  const totalCount = pageResult?.count ?? 0;

  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<Proctor> & { id: string }) => {
      const { id, ...payload } = updates;
      const { error } = await supabase
        .from('proctors')
        .update({
          ...payload,
          upd: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: async (_data, variables) => {
      const changedFields = Object.keys(variables).filter((key) => key !== 'id');
      await logAudit({
        action: 'Updated',
        target: editingProctor?.name || variables.id,
        detail: `Fields updated: ${changedFields.join(', ')} by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
      setEditingProctor(null);
    },
    onError: (error: any) => {
      showAlert('Save failed: ' + error.message, { tone: 'error' });
    },
  });

  const offboardMutation = useMutation({
    mutationFn: async (payload: { id: string; reason: string; notes: string }) => {
      const { error } = await supabase.rpc('offboard_proctor', {
        p_proctor_id: payload.id,
        p_reason: payload.reason,
        p_notes: payload.notes,
      });

      if (error) throw error;
    },
    onSuccess: async (_data, variables) => {
      const proctor = proctors.find((p) => p.id === variables.id);
      await logAudit({
        action: 'Offboarded',
        target: proctor?.name || variables.id,
        detail: `Reason: ${variables.reason}${variables.notes ? ` · Notes: ${variables.notes}` : ''} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setOffboardingProctor(null);
    },
    onError: (error: any) => {
      showAlert('Offboard failed: ' + error.message, { tone: 'error' });
    },
  });

  const handleExport = async () => {
    if (totalCount === 0) return;

    // Export means "everything matching the current filters", not just the
    // page currently on screen -- fetch fresh rather than reusing the
    // paginated table state, same as proctorService.getAll always returned
    // before pagination existed.
    const allMatching = await proctorService.getAll(filters);

    // Aadhaar is stored only as a one-way hash -- there's no plaintext for
    // anyone, admin included, to export. Phone/email aren't masked here because
    // they already aren't masked in the table itself for any role that can
    // reach this page.
    const exportData = allMatching.map((p) => ({
      ID: p.pid || '—',
      Name: p.name,
      Aadhaar: aadhaarStatus(p.aadhaar),
      Vendor: p.managed_by || p.vendor || '',
      Type: p.ptype,
      Phone: p.phone,
      Email: p.email,
      Status: p.status,
      BGV: p.bgv ? 'Uploaded' : 'Pending',
      'Form Submitted': p.form_submitted_at ? formatDate(p.form_submitted_at) : '',
      'NDA Signed': p.nda_signed_at ? formatDate(p.nda_signed_at) : '',
      'Vendor Verified': p.vendor_verified_at ? formatDate(p.vendor_verified_at) : '',
      Verified: p.vat ? formatDate(p.vat) : '',
      Activated: p.aat ? formatDate(p.aat) : '',
      Joined: formatDate(p.at),
    }));

    exportToCSV(exportData, 'proctors');
    logAudit({
      action: 'Exported',
      target: 'Proctors list',
      detail: `${exportData.length} row(s) exported by ${user?.username || user?.name || 'system'}`,
    });
  };

  const isPipelineStage = (status?: string) => status === 'In Progress' || status === 'Verified';

  // The NDA link's expiry is now policy-dependent (24h or same-day, see
  // nda_templates.expiry_policy) -- nda-session-create writes the real deadline it
  // computed to nda_link_expires_at alongside nda_triggered_at, so this list can check
  // the actual value instead of assuming a flat 24h.
  const isNdaLinkExpired = (row: Proctor) => {
    if (!row.nda_link_expires_at) return false;
    return Date.now() > new Date(row.nda_link_expires_at).getTime();
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.size === proctors.length ? new Set() : new Set(proctors.map((p) => p.id))));
  };

  const runBulkAction = async (label: string, totalSelected: number, ids: string[], action: (id: string) => Promise<void>) => {
    const ineligible = totalSelected - ids.length;
    if (ids.length === 0) {
      setBulkSummary({ text: `${label}: none of the ${totalSelected} selected proctor${totalSelected !== 1 ? 's' : ''} are eligible for this action`, tone: 'error' });
      setTimeout(() => setBulkSummary(null), 6000);
      return;
    }
    setBulkSummary(null);
    setBulkProgress({ label, done: 0, total: ids.length });
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await action(ids[i]);
        succeeded++;
      } catch {
        failed++;
      }
      setBulkProgress({ label, done: i + 1, total: ids.length });
    }
    setBulkProgress(null);
    const parts = [`${succeeded} succeeded`];
    if (failed) parts.push(`${failed} failed`);
    if (ineligible) parts.push(`${ineligible} not eligible`);
    setBulkSummary({
      text: `${label}: ${parts.join(', ')}`,
      tone: failed ? 'error' : ineligible ? 'warning' : 'success',
    });
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ['proctors'] });
    setTimeout(() => setBulkSummary(null), 6000);
  };

  const selectedProctors = proctors.filter((p) => selectedIds.has(p.id));

  // Powers the temporary "Email: Sending.../Failed" line under the Documents badge --
  // polled only while something's actually in flight, and only for proctors on the
  // current page. Disappears once the item resolves to sent; the NDA/Documents badges
  // above it (business lifecycle status) are completely unaffected either way.
  const visibleIds = proctors.map((p) => p.id);
  const { data: activeDispatch } = useQuery({
    queryKey: ['active-dispatch', 'send_onboarding_docs', visibleIds],
    queryFn: () => getActiveDispatchForProctors(visibleIds, 'send_onboarding_docs'),
    enabled: visibleIds.length > 0,
    refetchInterval: 4000,
  });
  const activeDispatchByProctor = new Map((activeDispatch?.items ?? []).map((i) => [i.proctor_id, i]));

  // Bulk sending is now a real Bulk Job -- the server (bulk-dispatch-create) is the
  // eligibility authority, so every selected id is sent, not just the ones this page's
  // own client-side filter thinks are eligible. Mailgun sending and session creation
  // happen afterward via bulk-dispatch-worker (immediate kick + a 1-minute cron
  // backstop), never blocking this request.
  const handleBulkSendDocs = async () => {
    if (selectedIds.size === 0) return;
    setBulkCreating(true);
    try {
      const result = await createBulkDispatch('SEND_ONBOARDING_DOCS', Array.from(selectedIds));
      setBulkSummary({
        text: `Bulk sending started: ${result.selected} selected, ${result.eligible} queued, ${result.skipped} skipped -- you can continue working while the emails are processed.`,
        tone: result.eligible > 0 ? 'success' : 'warning',
      });
      setSelectedIds(new Set());
      setActivityDrawer({ open: true, jobId: result.jobId });
      setTimeout(() => setBulkSummary(null), 8000);
    } catch (err: any) {
      showAlert('Failed to start bulk send: ' + err.message, { tone: 'error' });
    } finally {
      setBulkCreating(false);
    }
  };

  const handleBulkVerify = () =>
    runBulkAction(
      'Verify',
      selectedProctors.length,
      selectedProctors
        .filter((p) => p.nda_status === 'NDA Signed' && p.final_form_status === 'submitted' && !p.vendor_verified)
        .map((p) => p.id),
      async (id) => {
        const { error } = await supabase.rpc('verify_proctor', { p_proctor_id: id });
        if (error) throw error;
      }
    );

  const handleBulkActivate = () =>
    runBulkAction(
      'Activate',
      selectedProctors.length,
      selectedProctors
        .filter((p) => p.nda_status === 'NDA Signed' && p.final_form_status === 'submitted' && !p.pid)
        .map((p) => p.id),
      async (id) => {
        const { error } = await supabase.rpc('assign_proctor_id', { p_proctor_id: id });
        if (error) throw error;
      }
    );

  const handleBulkSetReady = (type: 'demo' | 'assessment') =>
    runBulkAction(
      `Set Ready — ${type === 'demo' ? 'Demo' : 'Assessment'}`,
      selectedProctors.length,
      selectedProctors
        .filter((p) => {
          const readyField = type === 'demo' ? p.demo_ready : p.assessment_ready;
          return readyField !== 'pass' && readyField !== 'ready';
        })
        .map((p) => p.id),
      async (id) => {
        const { error } = await supabase.rpc('mark_eval_ready', { p_proctor_id: id, p_eval_type: type });
        if (error) throw error;
      }
    );

  const columns = [
    {
      header: (
        <input
          type="checkbox"
          checked={proctors.length > 0 && selectedIds.size === proctors.length}
          onChange={toggleSelectAll}
          className="w-3.5 h-3.5 accent-accent cursor-pointer"
        />
      ),
      accessor: (row: Proctor) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.id)}
          onChange={() => toggleSelect(row.id)}
          onClick={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 accent-accent cursor-pointer"
        />
      ),
      className: 'w-8',
    },
    {
      header: 'ID',
      accessor: (row: Proctor) => (
        row.pid ? (
          <span className="font-mono text-xs text-accent">{row.pid}</span>
        ) : (
          <span className="text-[11px] text-text3">Not Assigned</span>
        )
      ),
      sortValue: (row: Proctor) => row.pid || '',
    },
    {
      header: 'Name',
      accessor: (row: Proctor) => (
        <div>
          <div className="font-semibold text-text">{row.name}</div>
          <div className="text-[11px] text-text3">{row.email || ''}</div>
        </div>
      ),
      sortValue: (row: Proctor) => row.name || '',
    },
    {
      header: 'Vendor / Type',
      accessor: (row: Proctor) => {
        const vendor = row.managed_by || row.vendor;
        return (
          <span className="text-[12px] text-text2 font-medium">
            {vendor || '—'}
            {vendor && row.ptype && <span className="text-text3 mx-1">|</span>}
            {row.ptype}
          </span>
        );
      },
    },
    {
      header: 'Status',
      accessor: (row: Proctor) => <Badge status={row.status} />,
      sortValue: (row: Proctor) => row.status || '',
    },
    {
      header: 'Demo / Assessment',
      accessor: (row: Proctor) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-text3 uppercase w-3" title="Demo">D</span>
            <PipelineEvalCell proctorId={row.id} value={row.demo_ready} type="demo" isVendor={isVendor} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-text3 uppercase w-3" title="Assessment">A</span>
            <PipelineEvalCell proctorId={row.id} value={row.assessment_ready} type="assessment" isVendor={isVendor} />
          </div>
        </div>
      ),
    },
    {
      header: 'NDA',
      accessor: (row: Proctor) => {
        if (row.nda_status === 'NDA Signed') return <span className="text-[11px] font-bold text-success">✓ Signed</span>;
        if (row.nda_status === 'NDA Pending') {
          if (isNdaLinkExpired(row)) return <span className="text-[11px] font-bold text-danger">Expired</span>;
          return <span className="text-[11px] font-bold text-warning">Pending</span>;
        }
        return <span className="text-[11px] text-text3">Not Started</span>;
      },
    },
    {
      header: 'Documents',
      accessor: (row: Proctor) => {
        const badge =
          row.final_form_status === 'submitted' ? (
            <span className="text-[11px] font-bold text-success">✓ Uploaded</span>
          ) : row.final_form_status === 'sent' ? (
            isNdaLinkExpired(row) ? (
              <span className="text-[11px] font-bold text-danger">Expired</span>
            ) : (
              <span className="text-[11px] font-bold text-warning">Pending</span>
            )
          ) : (
            <span className="text-[11px] text-text3">Not Started</span>
          );
        const dispatch = activeDispatchByProctor.get(row.id);
        return (
          <div>
            {badge}
            {dispatch?.status === 'processing' && (
              <div className="text-[10px] text-accent mt-0.5">Email: Sending…</div>
            )}
            {dispatch?.status === 'failed' && (
              <div className="text-[10px] text-danger mt-0.5" title={dispatch.failure_reason || ''}>
                Email: Failed
              </div>
            )}
          </div>
        );
      },
    },
    {
      header: 'Actions',
      className: 'whitespace-nowrap',
      accessor: (row: Proctor) =>
        isPipelineStage(row.status) ? (
          <PipelineActions proctor={row} isAdmin={isAdmin} isVendor={isVendor} onView={() => setSelectedProctor(row)} />
        ) : (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSelectedProctor(row)} className="!text-[11px] !px-2 !py-1">
              View
            </Button>
            {isAdmin && (
              <ActionMenu
                items={[
                  { label: 'Edit', onClick: () => setEditingProctor(row) },
                  {
                    label: 'Offboard',
                    onClick: () => setOffboardingProctor(row),
                    danger: true,
                    hidden: row.status !== 'Active',
                  },
                ]}
              />
            )}
          </div>
        ),
    },
  ];

  return (
    <div>
      {/* Filters */}
      <div className="bg-surface border border-border rounded-lg p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <Input
            placeholder="Search name, ID, email..."
            value={filters.search}
            onChange={(e) => {
              setFilters({ ...filters, search: e.target.value });
              setPage(1);
            }}
            wrapperClassName="flex-1 min-w-[200px]"
          />

          {!isVendor && (
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
          )}

          <Select
            options={[
              { value: '', label: 'All Status' },
              { value: 'In Progress', label: 'In Progress' },
              { value: 'Verified', label: 'Verified' },
              { value: 'Active', label: 'Active' },
              { value: 'Offboarded', label: 'Offboarded' },
            ]}
            value={filters.status}
            onChange={(e) => {
              setFilters({ ...filters, status: e.target.value as any });
              setPage(1);
            }}
            wrapperClassName="min-w-[140px]"
          />

          <Select
            options={[
              { value: '', label: 'All Types' },
              ...PROCTOR_TYPES.map((t) => ({ value: t, label: t })),
            ]}
            value={filters.ptype}
            onChange={(e) => {
              setFilters({ ...filters, ptype: e.target.value as any });
              setPage(1);
            }}
            wrapperClassName="min-w-[120px]"
          />

          <Select
            options={[
              { value: '', label: 'All Documents Status' },
              { value: 'not_started', label: 'Not Started' },
              { value: 'pending', label: 'Pending' },
              { value: 'expired', label: 'Expired' },
              { value: 'submitted', label: 'Uploaded' },
            ]}
            value={filters.docsStatus}
            onChange={(e) => {
              setFilters({ ...filters, docsStatus: e.target.value as any });
              setPage(1);
            }}
            wrapperClassName="min-w-[170px]"
          />

          <ClearFiltersButton
            show={!!(filters.search || filters.vendor || filters.status || filters.ptype || filters.docsStatus)}
            onClick={() => {
              setFilters({ search: '', vendor: '', status: '', ptype: '', docsStatus: '' });
              setPage(1);
            }}
          />

          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-text3">
              {totalCount} proctor{totalCount !== 1 ? 's' : ''}
            </span>
            {!isVendor && (
              <Button variant="ghost" size="sm" onClick={() => setActivityDrawer({ open: true, jobId: null })}>
                Bulk Activity
              </Button>
            )}
            {!isVendor && (
              <Button variant="ghost" size="sm" onClick={handleExport}>
                Export
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <Table
        data={proctors}
        columns={columns}
        isLoading={isLoading}
        emptyMessage="No proctors found. Try adjusting your filters."
        pagination={{ page, pageSize: PAGE_SIZE, count: totalCount, isFetching, onPageChange: setPage }}
      />

      <BulkActivityDrawer
        isOpen={activityDrawer.open}
        onClose={() => setActivityDrawer({ open: false, jobId: null })}
        initialJobId={activityDrawer.jobId}
      />

      {selectedProctor && (
        <ProctorDetailsModal
          proctor={selectedProctor}
          isAdmin={isAdmin}
          isVendor={isVendor}
          onClose={() => setSelectedProctor(null)}
        />
      )}

      {editingProctor && (
        <EditProctorModal
          proctor={editingProctor}
          isAdmin={isAdmin}
          onClose={() => setEditingProctor(null)}
          onSave={(updates) =>
            updateMutation.mutate({
              id: editingProctor.id,
              ...updates,
            })
          }
          isSaving={updateMutation.isPending}
        />
      )}

      {offboardingProctor && (
        <OffboardProctorModal
          proctor={offboardingProctor}
          onClose={() => setOffboardingProctor(null)}
          onConfirm={(reason, notes) =>
            offboardMutation.mutate({
              id: offboardingProctor.id,
              reason,
              notes,
            })
          }
          isSaving={offboardMutation.isPending}
        />
      )}

      {(bulkProgress || bulkSummary) && (
        <div
          className={`fixed top-4 right-4 z-[1100] bg-surface border-l-4 border border-border rounded-lg shadow-lg px-4 py-3 max-w-sm ${
            bulkProgress
              ? ''
              : bulkSummary?.tone === 'success'
                ? 'border-l-success'
                : bulkSummary?.tone === 'warning'
                  ? 'border-l-warning'
                  : 'border-l-danger'
          }`}
        >
          {bulkProgress ? (
            <div className="flex items-center gap-2 text-sm text-text">
              <Loader2 className="w-4 h-4 text-accent animate-spin flex-shrink-0" />
              <span>
                {bulkProgress.label}: {bulkProgress.done}/{bulkProgress.total}
              </span>
            </div>
          ) : (
            <div
              className={`text-sm font-medium ${
                bulkSummary?.tone === 'success'
                  ? 'text-success'
                  : bulkSummary?.tone === 'warning'
                    ? 'text-warning'
                    : 'text-danger'
              }`}
            >
              {bulkSummary?.text}
            </div>
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1100] bg-surface border border-border rounded-full shadow-lg px-4 py-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-text px-2">{selectedIds.size} selected</span>
          {isAdmin && (
            <>
              <Button variant="primary" size="sm" onClick={handleBulkSendDocs} disabled={!!bulkProgress || bulkCreating}>
                {bulkCreating ? 'Starting…' : 'Send Onboarding Docs'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleBulkVerify} disabled={!!bulkProgress}>
                Verify
              </Button>
              <Button variant="success" size="sm" onClick={handleBulkActivate} disabled={!!bulkProgress}>
                Activate
              </Button>
            </>
          )}
          {isVendor && (
            <>
              <Button variant="ghost" size="sm" onClick={() => handleBulkSetReady('demo')} disabled={!!bulkProgress}>
                Set Ready — Demo
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleBulkSetReady('assessment')} disabled={!!bulkProgress}>
                Set Ready — Assessment
              </Button>
            </>
          )}
          <button
            className="text-text3 hover:text-text text-xs px-2"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** Demo/Assessment readiness cell for pipeline-stage proctors, with the vendor's "Set Ready" action. */
function PipelineEvalCell({
  proctorId,
  value,
  type,
  isVendor,
}: {
  proctorId: string;
  value?: string;
  type: 'demo' | 'assessment';
  isVendor: boolean;
}) {
  const queryClient = useQueryClient();

  const setReadyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_eval_ready', {
        p_proctor_id: proctorId,
        p_eval_type: type,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
      showAlert('Marked as ready', { tone: 'success' });
    },
    onError: (error: any) => {
      showAlert('Failed: ' + error.message, { tone: 'error' });
    },
  });

  if (value === 'pass') {
    return <span className="text-[11px] font-bold text-success">✓ Pass</span>;
  }
  if (value === 'scheduled') {
    return <span className="text-[11px] font-bold text-accent">Scheduled</span>;
  }
  if (value === 'ready') {
    return <span className="text-[11px] font-bold text-info">✓ Ready</span>;
  }
  if (['reattempt', 'noshow', 'reschedule'].includes(value || '')) {
    const label = value === 'reattempt' ? 'Reattempt' : value === 'noshow' ? 'No Show' : 'Rescheduled';
    return (
      <div className="flex items-center gap-1">
        <span className="text-[11px] font-bold text-warning">{label}</span>
        {isVendor && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setReadyMutation.mutate()}
            disabled={setReadyMutation.isPending}
            className="!text-[10px] !px-2 !py-1"
          >
            Ready
          </Button>
        )}
      </div>
    );
  }
  if (isVendor) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setReadyMutation.mutate()}
        disabled={setReadyMutation.isPending}
        className="!text-[11px] !px-2 !py-1"
      >
        Set Ready
      </Button>
    );
  }
  return <span className="text-[11px] text-text3">Awaiting</span>;
}

/** Verify / Send Onboarding Docs actions for proctors still in the onboarding pipeline. */
function PipelineActions({
  proctor,
  isAdmin,
  isVendor,
  onView,
}: {
  proctor: Proctor;
  isAdmin: boolean;
  isVendor: boolean;
  onView: () => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const sendDocsMutation = useMutation({
    mutationFn: async () => {
      await invokeEdgeFunction('nda-session-create', { proctorId: proctor.id });
      await logAudit({
        action: 'NDA & Docs Triggered',
        target: proctor.name,
        detail: `NDA signing & document link sent by ${user?.username || 'system'}`,
        user: user?.username || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
    },
    onError: (error: any) => {
      showAlert('Failed to send onboarding docs: ' + error.message, { tone: 'error' });
    },
  });

  const demoPass = proctor.demo_ready === 'pass';
  const assessPass = proctor.assessment_ready === 'pass';
  const bothPass = demoPass && assessPass;
  const ndaSigned = proctor.nda_status === 'NDA Signed';
  const ndaPending = proctor.nda_status === 'NDA Pending';
  const docsSubmitted = proctor.final_form_status === 'submitted';

  // One button reflecting exactly where this proctor is in the pipeline --
  // Verify and Activate both just open the detail view (View button's onView),
  // where the signed NDA and uploaded documents can actually be reviewed before
  // either action is taken. Verify must complete (vendor_verified) before Activate
  // is ever reachable, matching the same order the backend now enforces.
  const nextAction = !bothPass ? (
    <Button variant="ghost" size="sm" disabled className="!text-[11px] !px-2 !py-1" title="Assessment and Demo must both pass first">
      Send Onboarding Docs
    </Button>
  ) : !ndaPending && !ndaSigned ? (
    <Button variant="primary" size="sm" onClick={() => sendDocsMutation.mutate()} disabled={sendDocsMutation.isPending} className="!text-[11px] !px-2 !py-1">
      Send Onboarding Docs
    </Button>
  ) : ndaPending && !ndaSigned ? (
    <Button variant="ghost" size="sm" onClick={() => sendDocsMutation.mutate()} disabled={sendDocsMutation.isPending} className="!text-[11px] !px-2 !py-1" title="Waiting for proctor to sign -- click to resend the link">
      Resend Docs
    </Button>
  ) : ndaSigned && !docsSubmitted ? (
    <Button variant="ghost" size="sm" onClick={() => sendDocsMutation.mutate()} disabled={sendDocsMutation.isPending} className="!text-[11px] !px-2 !py-1" title="NDA signed, waiting on documents -- click to resend the link">
      Resend Docs
    </Button>
  ) : ndaSigned && docsSubmitted && !proctor.vendor_verified ? (
    <Button variant="success" size="sm" onClick={onView} className="!text-[11px] !px-2 !py-1" title="Review the signed NDA and uploaded documents, then verify">
      Verify
    </Button>
  ) : proctor.vendor_verified && !proctor.pid ? (
    isAdmin ? (
      <Button variant="success" size="sm" onClick={onView} className="!text-[11px] !px-2 !py-1">
        Activate
      </Button>
    ) : (
      <span className="text-[11px] text-info font-semibold">Verified</span>
    )
  ) : proctor.pid ? (
    <span className="text-[11px] text-success font-semibold">Active</span>
  ) : null;

  if (!isAdmin) {
    return (
      <div className="flex flex-nowrap items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onView} className="!text-[11px] !px-2 !py-1">
          View
        </Button>
        {isVendor && ndaSigned && docsSubmitted && nextAction}
      </div>
    );
  }

  return (
    <div className="flex flex-nowrap items-center gap-1.5">
      <Button variant="ghost" size="sm" onClick={onView} className="!text-[11px] !px-2 !py-1">
        View
      </Button>

      {nextAction}
    </div>
  );
}

function ProctorDetailsModal({
  proctor,
  isAdmin,
  isVendor,
  onClose,
}: {
  proctor: Proctor;
  isAdmin: boolean;
  isVendor: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('verify_proctor', { p_proctor_id: proctor.id });
      if (error) throw error;
      await logAudit({
        action: 'Verified',
        target: proctor.name,
        detail: `Verification complete by ${user?.username || 'system'}`,
        user: user?.username || null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['proctors'] });
      await showAlert(`${proctor.name} has been verified.`, { tone: 'success' });
      onClose();
    },
    onError: (error: any) => {
      showAlert('Verify failed: ' + error.message, { tone: 'error' });
    },
  });

  // NDA-signing artifacts live in the non-public nda-signing bucket -- a stored path,
  // not a working URL, so opening one means minting a short-lived signed URL on click.
  // `downloadName` sets Content-Disposition via Supabase's `download` option, so
  // whatever the admin saves it as is named for the person who signed it, not the
  // internal session-scoped storage path.
  const openSignedDocument = async (path: string, downloadName?: string) => {
    const { data, error } = await supabase.storage
      .from('nda-signing')
      .createSignedUrl(path, 300, downloadName ? { download: downloadName } : undefined);
    if (error || !data?.signedUrl) {
      showAlert('Could not open this file: ' + (error?.message || 'unknown error'), { tone: 'error' });
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  // "sadiqmartialorg@gmail.com" + "nda" + ".../signed-nda.pdf" -> "sadiqmartialorg-nda.pdf".
  // Extension comes from the actual stored path, not assumed -- the 6 uploaded
  // documents accept PDF/JPG/PNG, so hardcoding .pdf would silently mislabel a photo.
  const signerFileName = (email: string | undefined, suffix: string, storagePath: string, fallbackId?: string) => {
    const local = (email || '').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '');
    const base = local || fallbackId || 'document';
    const ext = storagePath.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || 'pdf';
    return `${base}-${suffix}.${ext}`;
  };

  const docs = [
    { key: 'doc_resume', label: 'Resume' },
    { key: 'doc_passport_photo', label: 'Passport Photo' },
    { key: 'doc_grad_cert', label: 'Grad Certificate' },
    { key: 'doc_aadhaar_copy', label: 'Aadhaar Copy' },
    { key: 'doc_pan_copy', label: 'PAN Copy' },
    { key: 'doc_eye_test', label: 'Eye Test' },
  ] as const;

  // Admin correction: replace or remove an already-submitted document. Shadows the
  // proctor prop locally so the modal reflects the change immediately without
  // waiting for a refetch; the underlying proctors query is still invalidated so a
  // reopen (or the table behind it) picks it up too.
  const [docOverrides, setDocOverrides] = useState<Record<string, string | null>>({});
  const [docActionKind, setDocActionKind] = useState<string | null>(null);
  const getDocValue = (key: string) => (key in docOverrides ? docOverrides[key] : (proctor as any)[key]);

  const replaceDocMutation = useMutation({
    mutationFn: async ({ key, label, file }: { key: string; label: string; file: File }) => {
      setDocActionKind(key);
      const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
      const path = `proctors/${proctor.id}/${key}-${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('nda-signing').upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;

      const oldValue = getDocValue(key);
      const { error } = await supabase.from('proctors').update({ [key]: path, upd: new Date().toISOString() }).eq('id', proctor.id);
      if (error) throw error;

      await logAudit({
        action: 'Document Replaced',
        target: proctor.name,
        detail: `${label}: replaced by admin${oldValue ? ' (had a prior file on record)' : ''} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });

      setDocOverrides((prev) => ({ ...prev, [key]: path }));
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
    },
    onSuccess: () => setDocActionKind(null),
    onError: (error: any) => {
      setDocActionKind(null);
      showAlert('Replace failed: ' + error.message, { tone: 'error' });
    },
  });

  const removeDocMutation = useMutation({
    mutationFn: async ({ key, label }: { key: string; label: string }) => {
      const ok = await showConfirm(`Remove ${label} from ${proctor.name}'s record? They will need to submit it again.`, {
        title: 'Remove document',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) throw new Error('cancelled');
      setDocActionKind(key);

      const { error } = await supabase.from('proctors').update({ [key]: '', upd: new Date().toISOString() }).eq('id', proctor.id);
      if (error) throw error;

      await logAudit({
        action: 'Document Removed',
        target: proctor.name,
        detail: `${label}: marked incorrect and removed by admin · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });

      setDocOverrides((prev) => ({ ...prev, [key]: null }));
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
    },
    onSuccess: () => setDocActionKind(null),
    onError: (error: any) => {
      setDocActionKind(null);
      if (error.message !== 'cancelled') {
        showAlert('Remove failed: ' + error.message, { tone: 'error' });
      }
    },
  });

  const demoEval = proctor.demo_eval || '—';
  const assessment = proctor.assessment || '—';
  const ndaStatus = proctor.nda_status || '—';
  const demoOk = demoEval === 'Pass' || demoEval === 'pass';
  const assessOk = assessment === 'Pass' || assessment === 'pass';
  const ndaSigned = ndaStatus === 'NDA Signed';
  const ndaPending = ndaStatus === 'NDA Pending';

  const assignMutation = useMutation({
    mutationFn: async () => {
      const { data: newPid, error } = await supabase.rpc('assign_proctor_id', {
        p_proctor_id: proctor.id,
      });
      if (error) throw error;

      await logAudit({
        action: 'ID Assigned',
        target: proctor.name,
        detail: `ID: ${newPid} → Active · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });

      return newPid as string;
    },
    onSuccess: async (newPid) => {
      await queryClient.invalidateQueries({ queryKey: ['proctors'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      await showAlert(`ID ${newPid} assigned! ${proctor.name} is now Active.`, { tone: 'success' });
      onClose();
    },
    onError: (error: any) => {
      showAlert('Assign ID failed: ' + error.message, { tone: 'error' });
    },
  });

  const docsSubmitted = proctor.final_form_status === 'submitted';
  const steps = [
    { label: 'Submitted', done: proctor.form_status === 'submitted' || proctor.interview_stage !== 'interview_selected' },
    { label: 'Assessment', done: assessOk },
    { label: 'Demo', done: demoOk },
    { label: 'NDA signed', done: ndaSigned, warn: ndaPending },
    { label: 'Documents uploaded', done: docsSubmitted, warn: ndaSigned && !docsSubmitted },
    { label: 'Verified', done: proctor.status === 'Verified' || proctor.status === 'Active' },
    { label: 'Active', done: proctor.status === 'Active' },
  ];

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`${proctor.name}${proctor.pid ? ` — ${proctor.pid}` : ''}`}
      size="lg"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {steps.map((step, idx) => (
            <div key={step.label} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold ${
                  step.done
                    ? 'bg-success text-white'
                    : step.warn
                      ? 'bg-warning text-black'
                      : 'bg-surface2 text-text3'
                }`}
              >
                {step.done ? '✓' : step.warn ? <Clock className="w-3 h-3" /> : '○'} {step.label}
              </span>
              {idx < steps.length - 1 && <span className="text-text3 text-xs">›</span>}
            </div>
          ))}
        </div>

        <DetailSection title="Personal Details">
          <FieldRow label="Full Name" value={proctor.name} />
          <FieldRow label="Phone" value={formatPhone(proctor.phone)} />
          <FieldRow label="Email" value={proctor.email || '—'} />
          <FieldRow label="Aadhaar" value={aadhaarStatus(proctor.aadhaar)} />
          <FieldRow label="DOB" value={proctor.dob || '—'} />
          <FieldRow label="Gender" value={proctor.gender || '—'} />
          <FieldRow label="Location" value={[proctor.city, proctor.state].filter(Boolean).join(', ') || '—'} className="sm:col-span-2" />
        </DetailSection>

        <DetailSection title="Pipeline & Status">
          <FieldRow label="Proctor ID" value={proctor.pid || 'Not assigned yet'} mono />
          <FieldRow label="Status" value={proctor.status} />
          <FieldRow label="Vendor" value={proctor.managed_by || proctor.vendor || '—'} />
          <FieldRow label="Proctor Type" value={proctor.ptype || '—'} />
          <FieldRow label="Demo Evaluation" value={demoEval} />
          <FieldRow label="Assessment" value={assessment} />
          <FieldRow label="NDA Status" value={ndaStatus} />
          <FieldRow label="Form Status" value={proctor.form_status || '—'} />
          <FieldRow label="BGV" value={proctor.bgv ? 'Uploaded' : '—'} />
        </DetailSection>

        <DetailSection title="Timeline">
          <FieldRow label="Created By" value={`${proctor.by_user || '—'} · ${formatDate(proctor.at)}`} />
          <FieldRow label="Last Updated" value={formatDate(proctor.upd)} />
          <FieldRow label="Activated" value={proctor.aat ? formatDate(proctor.aat) : '—'} />
        </DetailSection>

        <DetailSection title="Documents & NDA">
          <div className="sm:col-span-2 divide-y divide-border -my-1">
            {docs.map((doc) => {
              const value = getDocValue(doc.key) as string | undefined | null;
              const isBusy = docActionKind === doc.key;
              return (
                <div key={doc.key} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-[12px] text-text2">{doc.label}</span>
                  <div className="flex items-center gap-3">
                    {value ? (
                      <button
                        onClick={() => openSignedDocument(value, signerFileName(proctor.email, doc.key.replace(/^doc_/, '').replace(/_/g, '-'), value, proctor.id))}
                        className="text-[12px] font-semibold text-accent hover:underline"
                      >
                        View
                      </button>
                    ) : (
                      <span className="text-[12px] text-text3">Missing</span>
                    )}
                    {isAdmin && (
                      <>
                        <label className="text-[11px] font-semibold text-text2 hover:text-text cursor-pointer">
                          {isBusy && replaceDocMutation.isPending ? 'Uploading...' : 'Replace'}
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            className="hidden"
                            disabled={replaceDocMutation.isPending || removeDocMutation.isPending}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) replaceDocMutation.mutate({ key: doc.key, label: doc.label, file });
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {value && (
                          <button
                            className="text-[11px] font-semibold text-danger hover:underline disabled:opacity-50"
                            disabled={replaceDocMutation.isPending || removeDocMutation.isPending}
                            onClick={() => removeDocMutation.mutate({ key: doc.key, label: doc.label })}
                          >
                            {isBusy && removeDocMutation.isPending ? 'Removing...' : 'Remove'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center justify-between gap-3 py-2">
              <span className="text-[12px] text-text2">NDA File</span>
              {proctor.nda_file_url ? (
                <button
                  onClick={() => openSignedDocument(proctor.nda_file_url!, signerFileName(proctor.email, 'nda', proctor.nda_file_url!, proctor.id))}
                  className="text-[12px] font-semibold text-accent hover:underline"
                >
                  View
                </button>
              ) : (
                <span className="text-[12px] text-text3">Missing</span>
              )}
            </div>
          </div>
        </DetailSection>

        {(isAdmin || isVendor) && ndaSigned && docsSubmitted && !proctor.vendor_verified && !proctor.pid && (
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="success" onClick={() => verifyMutation.mutate()} disabled={verifyMutation.isPending}>
              {verifyMutation.isPending ? 'Verifying...' : 'Verify'}
            </Button>
          </div>
        )}

        {isAdmin && proctor.vendor_verified && !proctor.pid && (
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="success" onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending}>
              {assignMutation.isPending ? 'Activating...' : 'Activate'}
            </Button>
          </div>
        )}

        {proctor.vendor_verified && !proctor.pid && (
          <div className="rounded-lg border border-info/30 bg-info/10 p-3 text-info text-sm">
            Proctor is verified{isAdmin ? ' — ready to activate.' : '.'}
          </div>
        )}

        {proctor.pid && (
          <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-success text-sm">
            Proctor is active with ID <strong>{proctor.pid}</strong>.
          </div>
        )}
      </div>
    </Modal>
  );
}

function EditProctorModal({
  proctor,
  isAdmin,
  onClose,
  onSave,
  isSaving,
}: {
  proctor: Proctor;
  isAdmin: boolean;
  onClose: () => void;
  onSave: (updates: Partial<Proctor>) => void;
  isSaving: boolean;
}) {
  const { data: managedByOptions = [] } = useManagedByOptions();
  const { formData, setField } = useFormState({
    name: proctor.name || '',
    // Aadhaar is stored only as a one-way hash -- there's nothing to prefill.
    // Left blank, it's excluded from the save payload so the existing hash is
    // untouched; typing a new 12-digit value here overwrites it.
    aadhaar: '',
    dob: proctor.dob || '',
    gender: proctor.gender || '',
    ptype: proctor.ptype || '',
    managed_by: proctor.managed_by || proctor.vendor || '',
    phone: proctor.phone || '',
    email: proctor.email || '',
    city: proctor.city || '',
    state: proctor.state || '',
    notes: proctor.notes || '',
  });
  const submit = () => {
    if (!isAdmin) return;
    if (!formData.name.trim()) return showAlert('Name is required', { tone: 'error' });
    if (formData.aadhaar && !/^\d{12}$/.test(formData.aadhaar)) return showAlert('Aadhaar must be exactly 12 digits', { tone: 'error' });
    if (formData.phone && !/^\d{10}$/.test(formData.phone)) return showAlert('Mobile number must be exactly 10 digits', { tone: 'error' });
    if (formData.email && !formData.email.includes('@')) return showAlert('Email address is not valid', { tone: 'error' });

    const { aadhaar, ...rest } = formData;
    onSave({
      ...rest,
      // Omit entirely when left blank -- an empty string would overwrite the
      // existing hash instead of leaving it unchanged.
      ...(aadhaar ? { aadhaar } : {}),
      vendor: formData.managed_by as any,
      managed_by: formData.managed_by as any,
    });
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`Edit ${proctor.name}`} size="lg">
      <div className="space-y-4">
        {!isAdmin && (
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-warning text-sm">
            Only administrators can edit proctors.
          </div>
        )}

        <FormSection title="Personal Details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Name" value={formData.name} onChange={(name) => setField('name', name)} />
            <Field
              label={`Aadhaar (${aadhaarStatus(proctor.aadhaar)})`}
              value={formData.aadhaar}
              onChange={(aadhaar) => setField('aadhaar', aadhaar.replace(/\D/g, '').slice(0, 12))}
              placeholder="Leave blank to keep unchanged"
            />
            <Field label="DOB" value={formData.dob} onChange={(dob) => setField('dob', dob)} type="date" />
            <SelectField
              label="Gender"
              value={formData.gender}
              onChange={(gender) => setField('gender', gender as Proctor['gender'])}
              options={['', 'Male', 'Female', 'Other']}
            />
            <SelectField
              label="Proctor Type"
              value={formData.ptype}
              onChange={(ptype) => setField('ptype', ptype as Proctor['ptype'])}
              options={['', 'WFO', 'ODP', 'Hybrid']}
            />
          </div>
        </FormSection>

        <FormSection title="Contact Details">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField
              label="Vendor"
              value={formData.managed_by}
              onChange={(managed_by) => setField('managed_by', managed_by as Proctor['managed_by'])}
              options={['', ...managedByOptions.map((option) => option.value)]}
            />
            <Field label="Phone" value={formData.phone} onChange={(phone) => setField('phone', phone)} />
            <Field label="Email" value={formData.email} onChange={(email) => setField('email', email)} />
            <Field label="City" value={formData.city} onChange={(city) => setField('city', city)} />
            <Field label="State" value={formData.state} onChange={(state) => setField('state', state)} />
          </div>
        </FormSection>

        <div>
          <label className="block text-xs font-semibold text-text mb-1">Notes</label>
          <textarea
            value={formData.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={3}
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-sm text-text outline-none focus:border-accent resize-none"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={isSaving || !isAdmin}>
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OffboardProctorModal({
  proctor,
  onClose,
  onConfirm,
  isSaving,
}: {
  proctor: Proctor;
  onClose: () => void;
  onConfirm: (reason: string, notes: string) => void;
  isSaving: boolean;
}) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const confirm = () => {
    if (!reason) {
      showAlert('Please select a reason', { tone: 'error' });
      return;
    }
    onConfirm(reason, notes);
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Offboard Proctor" size="md">
      <div className="space-y-4">
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-warning text-sm">
          Offboard <strong>{proctor.name}</strong> ({proctor.pid || 'No PID'})
        </div>

        <div>
          <label className="block text-xs font-semibold text-text mb-1">Reason *</label>
          <Select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            options={[
              { value: '', label: 'Select reason...' },
              { value: 'Contract ended', label: 'Contract ended' },
              { value: 'Resignation', label: 'Resignation' },
              { value: 'Policy violation', label: 'Policy violation' },
              { value: 'Performance issues', label: 'Performance issues' },
              { value: 'Other', label: 'Other' },
            ]}
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-text mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Additional notes..."
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-sm text-text outline-none focus:border-accent resize-none"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={isSaving}>
            {isSaving ? 'Offboarding...' : 'Confirm Offboard'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Groups related fields under one bordered card with a section heading -- fewer,
 * more meaningful cards instead of one card per field. */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface2 p-4">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-text3 mb-3">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">{children}</div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  mono = false,
  className = '',
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wide text-text3 mb-0.5">{label}</div>
      <div className={`text-[13px] text-text ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-text mb-1">{label}</label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-text mb-1">{label}</label>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={options.map((opt) => ({ value: opt, label: opt || 'Select...' }))}
      />
    </div>
  );
}
