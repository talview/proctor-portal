import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Mail, CheckCircle2, Zap, Video, ClipboardCheck, Calendar, CheckCheck, RotateCcw, UserX, CalendarClock, Circle } from 'lucide-react';
import { supabase, invokeEdgeFunction } from '@/services/supabase';
import { proctorService } from '@/services/proctor';
import { useCursorPaginatedQuery } from '@/hooks/useCursorPaginatedQuery';
import type { ColumnDef } from '@tanstack/react-table';
import { useFormState } from '@/hooks/useFormState';
import DataTable from '@/components/ui/DataTable';
import FormSection from '@/components/ui/FormSection';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Avatar from '@/components/ui/Avatar';
import VendorTypeCell from '@/components/ui/VendorTypeCell';
import { FilterTrigger, FilterChips, type FilterFieldDef } from '@/components/ui/FilterBuilder';
import Modal from '@/components/ui/Modal';
import Drawer from '@/components/ui/Drawer';
import SelectionActionBar, { SelectionAction } from '@/components/ui/SelectionActionBar';
import DispatchStatusCell from '@/components/ui/DispatchStatusCell';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import StatusLegend from '@/components/ui/StatusLegend';
import DispatchStatusLegend from '@/components/ui/DispatchStatusLegend';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import { logAudit } from '@/services/audit';
import { formatDate, exportToCSV, aadhaarStatus, formatPhone } from '@/utils/formatters';
import { EXPORT_ROW_CAP } from '@/lib/csv';
import { useVendorOptions } from '@/hooks/useVendorOptions';
import { useAuthStore } from '@/stores/auth';
import { PROCTOR_TYPES, PROCTOR_SEARCH_COLUMNS } from '@/utils/constants';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import { useUIStore } from '@/stores/ui';
import { createBulkDispatch, getActiveDispatchForProctors } from '@/services/bulkDispatch';
import type { Proctor, ProctorFilters } from '@/types';

// Above this many recipients, confirm before firing a bulk send -- guards against an
// accidental "select all" rather than any real system limit (the worker already
// throttles actual sending to 50 items/minute regardless of how many are queued).
const LARGE_BULK_SEND_THRESHOLD = 100;

// Status options for the "Status" field inside FilterBuilder -- matching
// Badge.tsx's own status values/tones.
const STATUS_OPTIONS = [
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Verified', label: 'Verified' },
  { value: 'Active', label: 'Active' },
  { value: 'Offboarded', label: 'Offboarded' },
];

// Full literal class strings -- Tailwind's JIT scanner can't see classes built by
// string interpolation (`bg-${tone}`). Single-select toggle buttons mirroring
// SelectionActionBar's own Send Docs/Verify/Activate bulk actions.
const ELIGIBILITY_CHIPS: { label: string; title: string; value: 'send_docs' | 'verify' | 'activate'; Icon: typeof Mail; activeClass: string }[] = [
  { label: 'Docs & NDA', title: 'Ready to send Docs & NDA', value: 'send_docs', Icon: Mail, activeClass: 'bg-warning/10 text-warning border-transparent' },
  { label: 'Verify', title: 'Verify eligible', value: 'verify', Icon: CheckCircle2, activeClass: 'bg-info/10 text-info border-transparent' },
  { label: 'Activate', title: 'Activate eligible', value: 'activate', Icon: Zap, activeClass: 'bg-success/10 text-success border-transparent' },
];

export default function ProctorsPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  // The notification panel's activity updates only carry a proctor's *name*
  // (that's all audit_log rows ever stored, see ProctorsPage's own logAudit
  // calls) -- there's no id to deep-link to directly, so a single-item
  // update lands here with the name pre-filled into search instead.
  const initialSearch = (location.state as { searchQuery?: string } | null)?.searchQuery || '';
  const [filters, setFilters] = useState<ProctorFilters>({
    search: initialSearch,
    vendor: '',
    status: '',
    ptype: '',
    docsStatus: '',
    eligibility: '',
  });
  const [activeProctor, setActiveProctor] = useState<Proctor | null>(null);
  const [drawerMode, setDrawerMode] = useState<'view' | 'edit'>('view');
  const [offboardingProctor, setOffboardingProctor] = useState<Proctor | null>(null);
  // Grace window for the "Email: Sending..." poll below -- set the moment a bulk
  // send is kicked off, so the poll picks up newly-queued items even if nothing was
  // in flight (and the poll had already stopped) right before the click.
  const [dispatchedAt, setDispatchedAt] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ text: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const openBulkActivity = useUIStore((s) => s.openBulkActivity);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search || '');
  const { data: vendorOptions = [] } = useVendorOptions();

  // Deep link from the command palette's proctor search (⌘K): it can't just open
  // the drawer directly (this table's own cursor-paginated page/filter state might
  // not include that proctor at all), so it navigates here with the id in location
  // state and this fetches that one row directly instead. Consumed exactly once --
  // replacing the state right after means refreshing the page or navigating away
  // and back doesn't reopen the same drawer from stale history state.
  const openProctorId = (location.state as { openProctorId?: string } | null)?.openProctorId;
  const didConsumeDeepLinkRef = useRef(false);
  useEffect(() => {
    if (!openProctorId || didConsumeDeepLinkRef.current) return;
    didConsumeDeepLinkRef.current = true;
    navigate(location.pathname, { replace: true, state: {} });
    proctorService.getById(openProctorId)
      .then((proctor) => {
        if (proctor) {
          setActiveProctor(proctor);
          setDrawerMode('view');
        } else {
          showAlert('That proctor could not be found -- it may have been removed.', { tone: 'error' });
        }
      })
      .catch((err: any) => showAlert('Failed to open proctor: ' + err.message, { tone: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProctorId]);

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
  // Cursor (keyset) pagination -- resetKey mirrors every filter that changes the
  // underlying result set, so switching a filter snaps back to the first page;
  // search debounces on its own inside the hook.
  const {
    data: proctors,
    isLoading,
    isFetching,
    hasNextPage,
    hasPreviousPage,
    goToNextPage,
    goToPreviousPage,
    pageIndex,
  } = useCursorPaginatedQuery<Proctor>({
    queryKey: ['proctors', filters.vendor, filters.status, filters.ptype, filters.docsStatus, filters.eligibility],
    table: 'proctors',
    filters: (q) => {
      // Archived rows are re-onboarding history (Offboarded & History page);
      // interview_selected candidates haven't submitted the form yet (Interview
      // Selects page) -- neither belongs in this list, matching proctorService.getAll.
      let query = q.neq('status', 'Archived').neq('interview_stage', 'interview_selected');
      if (filters.vendor) query = query.eq('vendor', filters.vendor);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.ptype) query = query.eq('ptype', filters.ptype);
      // Mirrors the exact predicates handleBulkSendDocs (server-side, via
      // checkOnboardingDocsEligibility)/handleBulkVerify/PipelineActions' own
      // Activate condition already use -- "who's eligible right now", not a stored column.
      if (filters.eligibility === 'send_docs') {
        query = query.eq('demo_ready', 'pass').eq('assessment_ready', 'pass').neq('nda_status', 'NDA Signed');
      } else if (filters.eligibility === 'verify') {
        query = query
          .eq('nda_status', 'NDA Signed')
          .eq('final_form_status', 'submitted')
          .or('vendor_verified.is.null,vendor_verified.eq.false');
      } else if (filters.eligibility === 'activate') {
        query = query.eq('vendor_verified', true).is('pid', null);
      }
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
    searchColumns: PROCTOR_SEARCH_COLUMNS,
    searchTerm: debouncedSearch,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'at', ascending: false },
    resetKey: `${filters.vendor}|${filters.status}|${filters.ptype}|${filters.docsStatus}|${filters.eligibility}`,
    // Narrowed from select('*') -- verified against every field this page's table
    // columns, ProctorDrawer, and OffboardProctorModal actually read (handleExport's
    // CSV path fetches its own full copy separately, so isn't constrained by this
    // list). Must include the six doc_* columns ProctorDrawer's Documents tab reads
    // via getDocValue -- their earlier omission here (not a data/design problem, just
    // a missed column in this string) meant every document silently rendered as
    // "Missing" regardless of real upload state.
    select: 'id, pid, name, aadhaar, phone, email, address, city, state, dob, gender, ptype, bgv, notes, status, by_user, at, upd, demo_eval, assessment, demo_ready, assessment_ready, nda_status, nda_file_url, nda_link_expires_at, nda_triggered_at, nda_viewed_at, interview_stage, form_status, vendor, vendor_verified, final_form_status, doc_resume, doc_passport_photo, doc_grad_cert, doc_aadhaar_copy, doc_pan_copy, doc_eye_test',
  });

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
        target: activeProctor?.name || variables.id,
        detail: `Fields updated: ${changedFields.join(', ')} by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
      setActiveProctor(null);
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
    if (proctors.length === 0 && pageIndex === 0) return;

    // Export means "everything matching the current filters", not just the
    // page currently on screen -- fetch fresh rather than reusing the
    // paginated table state, same as proctorService.getAll always returned
    // before pagination existed.
    const { rows: allMatching, truncated } = await proctorService.getAll(filters);

    // Aadhaar is stored only as a one-way hash -- there's no plaintext for
    // anyone, admin included, to export. Phone/email aren't masked here because
    // they already aren't masked in the table itself for any role that can
    // reach this page.
    const exportData = allMatching.map((p) => ({
      ID: p.pid || '—',
      Name: p.name,
      Aadhaar: aadhaarStatus(p.aadhaar),
      Vendor: p.vendor || '',
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
    if (truncated) {
      showAlert(
        `Export capped at ${EXPORT_ROW_CAP.toLocaleString()} rows -- narrow your filters to get a complete export.`,
        { tone: 'error' }
      );
    }
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

  // "Select all" adds/removes only this page's rows from whatever's already
  // selected, rather than replacing the whole selection -- a bulk send now
  // correctly covers rows picked on an earlier page too, not just the page the
  // send button happened to be clicked from.
  const isCurrentPageFullySelected = proctors.length > 0 && proctors.every((p) => selectedIds.has(p.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isCurrentPageFullySelected) {
        proctors.forEach((p) => next.delete(p.id));
      } else {
        proctors.forEach((p) => next.add(p.id));
      }
      return next;
    });
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
    // bulk-dispatch-status is admin-only server-side -- gating here too avoids a
    // guaranteed-to-fail request on every poll for coordinators viewing this page
    // via /my-proctors.
    enabled: isAdmin && visibleIds.length > 0,
    // Only keep polling while something's actually in flight, or for 2 minutes right
    // after a bulk send (items start out 'queued' and briefly show as nothing-active
    // until the worker picks them up) -- was previously unconditional, polling every
    // 4s for as long as the tab stayed open regardless of any real activity.
    refetchInterval: (query) => {
      const stillActive = (query.state.data?.items ?? []).length > 0;
      const withinGraceWindow = dispatchedAt !== null && Date.now() - dispatchedAt < 2 * 60_000;
      return stillActive || withinGraceWindow ? 4000 : false;
    },
  });
  const activeDispatchByProctor = new Map((activeDispatch?.items ?? []).map((i) => [i.proctor_id, i]));

  // Bulk sending is now a real Bulk Job -- the server (bulk-dispatch-create) is the
  // eligibility authority, so every selected id is sent, not just the ones this page's
  // own client-side filter thinks are eligible. Mailgun sending and session creation
  // happen afterward via bulk-dispatch-worker (immediate kick + a 1-minute cron
  // backstop), never blocking this request.
  const handleBulkSendDocs = async () => {
    if (selectedIds.size === 0) return;
    if (selectedIds.size > LARGE_BULK_SEND_THRESHOLD) {
      const ok = await showConfirm(
        `You're about to send onboarding docs to ${selectedIds.size} proctors. Continue?`,
        { confirmLabel: 'Send' }
      );
      if (!ok) return;
    }
    setBulkCreating(true);
    try {
      const result = await createBulkDispatch('SEND_ONBOARDING_DOCS', Array.from(selectedIds));
      setBulkSummary({
        text: `Bulk sending started: ${result.selected} selected, ${result.eligible} queued, ${result.skipped} skipped -- you can continue working while the emails are processed.`,
        tone: result.eligible > 0 ? 'success' : 'warning',
      });
      setSelectedIds(new Set());
      openBulkActivity(result.jobId);
      if (result.eligible > 0) setDispatchedAt(Date.now());
      setTimeout(() => setBulkSummary(null), 8000);
    } catch (err: any) {
      showAlert('Failed to start bulk send: ' + err.message, { tone: 'error' });
    } finally {
      setBulkCreating(false);
    }
  };

  // Bulk Verify/Activate/Set Ready used to run silently -- zero audit_log rows,
  // regardless of how many proctors were affected, unlike every other bulk action
  // in the app. Each now logs one row per proctor (matching the existing
  // single-item pattern these RPCs already have elsewhere), which the
  // notification bell's Updates tab aggregates into "{actor} verified N
  // proctors" instead of N separate entries.
  const actorLabel = user?.username || user?.name || 'system';

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
        const proctor = selectedProctors.find((p) => p.id === id);
        await logAudit({
          action: 'Verified',
          target: proctor?.name || id,
          detail: `Verification complete (bulk) by ${actorLabel}`,
          user: user?.username || null,
        });
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
        const { data: newPid, error } = await supabase.rpc('assign_proctor_id', { p_proctor_id: id });
        if (error) throw error;
        const proctor = selectedProctors.find((p) => p.id === id);
        await logAudit({
          action: 'ID Assigned',
          target: proctor?.name || id,
          detail: `ID: ${newPid} → Active (bulk) · by ${actorLabel}`,
          user: user?.username || null,
        });
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
        const proctor = selectedProctors.find((p) => p.id === id);
        await logAudit({
          action: type === 'demo' ? 'Marked Demo Ready' : 'Marked Assessment Ready',
          target: proctor?.name || id,
          detail: `Marked ready (bulk) by ${actorLabel}`,
          user: user?.username || null,
        });
      }
    );

  const columns: ColumnDef<Proctor, any>[] = [
    {
      id: 'select',
      header: () => (
        <input
          type="checkbox"
          checked={isCurrentPageFullySelected}
          onChange={toggleSelectAll}
          className="w-3.5 h-3.5 accent-accent cursor-pointer"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.original.id)}
          onChange={() => toggleSelect(row.original.id)}
          onClick={(e) => e.stopPropagation()}
          className="w-3.5 h-3.5 accent-accent cursor-pointer"
        />
      ),
      enableSorting: false,
      meta: { className: 'w-8' },
    },
    {
      id: 'pid',
      accessorFn: (row) => row.pid || '',
      header: 'ID',
      // Sorting is disabled table-wide here (see the `sorting` note above) --
      // cursor pagination has exactly one server-side order column ('at'), so a
      // clickable header on any other column would only ever reorder the rows
      // already loaded on screen, silently reshuffling per page instead of the
      // whole dataset.
      enableSorting: false,
      cell: ({ row }) => (
        row.original.pid ? (
          <span className="font-mono text-xs text-accent">{row.original.pid}</span>
        ) : (
          <span className="text-[11px] text-text3">Not Assigned</span>
        )
      ),
      meta: { className: '!px-2' },
    },
    {
      id: 'name',
      accessorFn: (row) => row.name || '',
      header: 'Name',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 max-w-[190px]">
          <Avatar name={row.original.name} size="sm" />
          <div className="min-w-0">
            <div className="font-semibold text-text truncate" title={row.original.name}>{row.original.name}</div>
            <div className="text-[11px] text-text3 truncate" title={row.original.email || ''}>{row.original.email || ''}</div>
          </div>
        </div>
      ),
    },
    {
      id: 'vendor_type',
      header: 'Vendor',
      enableSorting: false,
      cell: ({ row }) => <VendorTypeCell vendor={row.original.vendor} ptype={row.original.ptype} />,
      meta: { className: '!px-2' },
    },
    {
      id: 'status',
      accessorFn: (row) => row.status || '',
      header: 'Status',
      enableSorting: false,
      cell: ({ row }) => <Badge status={row.original.status} />,
      meta: { className: '!px-2' },
    },
    {
      id: 'demo',
      header: () => (
        <span className="inline-flex items-center gap-1">
          Demo
          {!isVendor && <StatusLegend title="Demo status" items={EVAL_STATUS_LEGEND_ITEMS} />}
        </span>
      ),
      enableSorting: false,
      cell: ({ row }) => <PipelineEvalCell proctorId={row.original.id} proctorName={row.original.name} value={row.original.demo_ready} type="demo" isVendor={isVendor} />,
      meta: { className: '!px-2' },
    },
    {
      id: 'assessment',
      header: () => <span title="Assessment">Assess.</span>,
      enableSorting: false,
      cell: ({ row }) => <PipelineEvalCell proctorId={row.original.id} proctorName={row.original.name} value={row.original.assessment_ready} type="assessment" isVendor={isVendor} />,
      meta: { className: '!px-2' },
    },
    {
      id: 'nda',
      header: () => (
        <span className="inline-flex items-center gap-1">
          NDA
          <DispatchStatusLegend />
        </span>
      ),
      enableSorting: false,
      // Same trigger/view timestamps as the Documents column below -- NDA signing and
      // docs upload are two independently-completable actions on the one session that
      // "Send NDA & Docs" creates, so a candidate can genuinely be NDA-Completed while
      // Documents is still Sent (or the reverse).
      cell: ({ row }) => (
        <DispatchStatusCell
          flow={{
            completed: row.original.nda_status === 'NDA Signed',
            expired: row.original.nda_status === 'NDA Pending' && isNdaLinkExpired(row.original),
            viewed: !!row.original.nda_viewed_at,
            lastSucceededAt: row.original.nda_triggered_at,
          }}
          dispatch={activeDispatchByProctor.get(row.original.id)}
        />
      ),
      meta: { className: '!px-2' },
    },
    {
      id: 'documents',
      header: () => (
        <span className="inline-flex items-center gap-1" title="Documents">
          Docs
          <DispatchStatusLegend />
        </span>
      ),
      enableSorting: false,
      cell: ({ row }) => (
        <DispatchStatusCell
          flow={{
            completed: row.original.final_form_status === 'submitted',
            expired: row.original.final_form_status === 'sent' && isNdaLinkExpired(row.original),
            viewed: !!row.original.nda_viewed_at,
            lastSucceededAt: row.original.nda_triggered_at,
          }}
          dispatch={activeDispatchByProctor.get(row.original.id)}
        />
      ),
      meta: { className: '!px-2' },
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      meta: { className: '!px-2 whitespace-nowrap' },
      // The whole row is clickable (opens the drawer -- see onRowClick below);
      // Edit/Offboard now live inside the drawer's own header, so this column is
      // only for the one contextual pipeline action (Send Docs/Verify/Activate)
      // that a row click shouldn't also trigger -- empty for everything else.
      cell: ({ row }) => {
        const proctor = row.original;
        if (!isPipelineStage(proctor.status)) return null;
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <PipelineActions proctor={proctor} isAdmin={isAdmin} isVendor={isVendor} onView={() => { setActiveProctor(proctor); setDrawerMode('view'); }} />
          </div>
        );
      },
    },
  ];

  const proctorFilterFields: FilterFieldDef[] = [
    { key: 'status', label: 'Status', options: STATUS_OPTIONS },
    ...(!isVendor ? [{ key: 'vendor', label: 'Vendor', options: vendorOptions } as FilterFieldDef] : []),
    { key: 'ptype', label: 'Type', options: PROCTOR_TYPES.map((t) => ({ value: t, label: t })) },
    {
      key: 'docsStatus',
      label: 'Documents Status',
      options: [
        { value: 'not_started', label: 'Not Started' },
        { value: 'pending', label: 'Pending' },
        { value: 'expired', label: 'Expired' },
        { value: 'submitted', label: 'Uploaded' },
      ],
    },
  ];
  const filterValues = { status: filters.status || '', vendor: filters.vendor || '', ptype: filters.ptype || '', docsStatus: filters.docsStatus || '' };
  const handleFilterFieldChange = (key: string, value: string) => setFilters({ ...filters, [key]: value } as ProctorFilters);

  return (
    <div>
      {/* Filters -- deliberately not boxed in its own card: a flat row of controls
          sitting directly on the page. The 3 eligibility buttons mirror
          SelectionActionBar's own bulk actions (Send Docs/Verify/Activate) as a
          quick "who could I act on right now" view; everything else (Status,
          Vendor, Type, Documents Status) lives behind one "Add Filter" builder so
          this row stays short enough to never wrap at 100% zoom. Applied filter
          chips render on their own row below (see filterValues/hasActiveFilters)
          instead of inline here, so adding one never reflows this row and shoves
          Export down with it. */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Input
            placeholder="Search name, ID, email..."
            value={filters.search}
            onChange={(e) => {
              setFilters({ ...filters, search: e.target.value });
            }}
            wrapperClassName="w-[220px]"
          />

          <div className="flex items-center gap-1 flex-wrap">
            {ELIGIBILITY_CHIPS.map((chip) => {
              const active = filters.eligibility === chip.value;
              return (
                <button
                  key={chip.value}
                  type="button"
                  title={chip.title}
                  onClick={() => setFilters({ ...filters, eligibility: active ? '' : (chip.value as any) })}
                  className={`inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-1.5 rounded-lg border transition-colors whitespace-nowrap ${
                    active ? chip.activeClass : 'bg-surface border-border text-text2 hover:border-border2'
                  }`}
                >
                  <chip.Icon className="w-3.5 h-3.5" />
                  {chip.label}
                </button>
              );
            })}
          </div>

          <div className="w-px h-5 bg-border flex-shrink-0" />

          <FilterTrigger fields={proctorFilterFields} values={filterValues} onChange={handleFilterFieldChange} />

          <ClearFiltersButton
            show={!!(filters.search || filters.vendor || filters.status || filters.ptype || filters.docsStatus || filters.eligibility)}
            onClick={() => {
              setFilters({ search: '', vendor: '', status: '', ptype: '', docsStatus: '', eligibility: '' });
            }}
          />
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!isVendor && (
            <Button variant="ghost" size="sm" onClick={handleExport}>
              Export
            </Button>
          )}
        </div>
      </div>

      <div className="mb-3">
        <FilterChips fields={proctorFilterFields} values={filterValues} onChange={handleFilterFieldChange} />
      </div>

      {/* Table */}
      <DataTable
        data={proctors}
        columns={columns}
        isLoading={isLoading}
        onRowClick={(proctor) => { setActiveProctor(proctor); setDrawerMode('view'); }}
        emptyMessage="No proctors found. Try adjusting your filters."
        pagination={{
          pageIndex,
          pageSize: PAGE_SIZE,
          hasNextPage,
          hasPreviousPage,
          isFetching,
          onNext: goToNextPage,
          onPrevious: goToPreviousPage,
        }}
      />

      {activeProctor && (
        <ProctorDrawer
          proctor={activeProctor}
          mode={drawerMode}
          isAdmin={isAdmin}
          isVendor={isVendor}
          onClose={() => setActiveProctor(null)}
          onEdit={() => setDrawerMode('edit')}
          onCancelEdit={() => setDrawerMode('view')}
          onSave={(updates) =>
            updateMutation.mutate({
              id: activeProctor.id,
              ...updates,
            })
          }
          isSaving={updateMutation.isPending}
          onOffboard={(p) => setOffboardingProctor(p)}
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
        <SelectionActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          {isAdmin && (
            <>
              <SelectionAction
                icon={Mail}
                label={bulkCreating ? 'Starting…' : 'Send Docs'}
                onClick={handleBulkSendDocs}
                disabled={!!bulkProgress || bulkCreating}
              />
              <SelectionAction
                icon={CheckCircle2}
                iconClassName="text-emerald-400"
                label="Verify"
                onClick={handleBulkVerify}
                disabled={!!bulkProgress}
              />
              <SelectionAction
                icon={Zap}
                iconClassName="text-amber-400"
                label="Activate"
                onClick={handleBulkActivate}
                disabled={!!bulkProgress}
              />
            </>
          )}
          {isVendor && (
            <>
              <SelectionAction
                icon={Video}
                iconClassName="text-emerald-400"
                label="Set Ready — Demo"
                onClick={() => handleBulkSetReady('demo')}
                disabled={!!bulkProgress}
              />
              <SelectionAction
                icon={ClipboardCheck}
                iconClassName="text-emerald-400"
                label="Set Ready — Assessment"
                onClick={() => handleBulkSetReady('assessment')}
                disabled={!!bulkProgress}
              />
            </>
          )}
        </SelectionActionBar>
      )}
    </div>
  );
}

/** Icon vocabulary for the Demo/Assessment status chip (admin/coordinator's
 * read-only view) -- each state stays visually distinct (not just color, per
 * DispatchStatusCell's same principle) since "reattempt"/"no show"/"rescheduled"
 * all share the warning tone but mean different things. */
const EVAL_STATUS_MAP: Record<string, { Icon: typeof Circle; label: string; className: string }> = {
  pass: { Icon: CheckCircle2, label: 'Pass', className: 'text-success' },
  scheduled: { Icon: Calendar, label: 'Scheduled', className: 'text-accent' },
  ready: { Icon: CheckCheck, label: 'Ready', className: 'text-info' },
  reattempt: { Icon: RotateCcw, label: 'Reattempt', className: 'text-warning' },
  noshow: { Icon: UserX, label: 'No Show', className: 'text-warning' },
  reschedule: { Icon: CalendarClock, label: 'Rescheduled', className: 'text-warning' },
};
const EVAL_STATUS_LEGEND_ITEMS = [
  { Icon: Circle, label: 'Awaiting', desc: 'Not yet scheduled or evaluated', className: 'text-text3' },
  { Icon: Calendar, label: 'Scheduled', desc: 'A session is booked', className: 'text-accent' },
  { Icon: CheckCheck, label: 'Ready', desc: 'Vendor marked ready for evaluation', className: 'text-info' },
  { Icon: RotateCcw, label: 'Reattempt', desc: 'Needs another attempt', className: 'text-warning' },
  { Icon: UserX, label: 'No Show', desc: 'Missed the scheduled session', className: 'text-warning' },
  { Icon: CalendarClock, label: 'Rescheduled', desc: 'Session moved to a new time', className: 'text-warning' },
  { Icon: CheckCircle2, label: 'Pass', desc: 'Passed evaluation', className: 'text-success' },
];

function EvalStatusIcon({ value }: { value?: string }) {
  const entry = (value && EVAL_STATUS_MAP[value]) || { Icon: Circle, label: 'Awaiting', className: 'text-text3' };
  const { Icon, label, className } = entry;
  return (
    <span title={label} className="inline-flex">
      <Icon className={`w-3.5 h-3.5 ${className}`} />
    </span>
  );
}

/** Demo/Assessment readiness cell for pipeline-stage proctors, with the vendor's "Set Ready" action. */
function PipelineEvalCell({
  proctorId,
  proctorName,
  value,
  type,
  isVendor,
}: {
  proctorId: string;
  proctorName: string;
  value?: string;
  type: 'demo' | 'assessment';
  isVendor: boolean;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const setReadyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_eval_ready', {
        p_proctor_id: proctorId,
        p_eval_type: type,
      });
      if (error) throw error;
      await logAudit({
        action: type === 'demo' ? 'Marked Demo Ready' : 'Marked Assessment Ready',
        target: proctorName,
        detail: `Marked ready by ${user?.username || user?.name || 'system'}`,
        user: user?.username || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proctors'] });
      showAlert('Marked as ready', { tone: 'success' });
    },
    onError: (error: any) => {
      showAlert('Failed: ' + error.message, { tone: 'error' });
    },
  });

  // Read-only roles (admin/coordinator) get the compact icon-only chip -- vendor
  // keeps the text+button rendering below unchanged, since a "Set Ready"/"Ready"
  // action genuinely needs to stay a clickable label, not just an icon.
  if (!isVendor) {
    return <EvalStatusIcon value={value} />;
  }

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
      Send Docs
    </Button>
  ) : !ndaPending && !ndaSigned ? (
    <Button variant="primary" size="sm" onClick={() => sendDocsMutation.mutate()} disabled={sendDocsMutation.isPending} className="!text-[11px] !px-2 !py-1" title="Send onboarding docs & NDA">
      Send Docs
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
        {isVendor && ndaSigned && docsSubmitted && nextAction}
      </div>
    );
  }

  return (
    <div className="flex flex-nowrap items-center gap-1.5">
      {nextAction}
    </div>
  );
}

// Exported so OffboardedPage can reuse it for its own (read-only) "View" action --
// one implementation of the whole Overview/Documents/Evaluations/Activity drawer,
// not a second one for offboarded records specifically.
export function ProctorDrawer({
  proctor,
  mode,
  isAdmin,
  isVendor,
  onClose,
  onEdit,
  onCancelEdit,
  onSave,
  isSaving,
  onOffboard,
}: {
  proctor: Proctor;
  mode: 'view' | 'edit';
  isAdmin: boolean;
  isVendor: boolean;
  onClose: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Partial<Proctor>) => void;
  isSaving: boolean;
  /** Offboard used to live behind a row's three-dot menu -- now it's here instead,
   * next to Edit, since the menu (and the row's separate View button) are both gone
   * in favor of "click the row to open this drawer." Omitted entirely by
   * OffboardedPage, which reuses this same drawer read-only for already-offboarded
   * records where the button couldn't apply anyway (gated on status === 'Active'). */
  onOffboard?: (proctor: Proctor) => void;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'evaluations' | 'activity'>('overview');

  // ---------------------------------------------------------------------
  // View-mode state & mutations (unchanged from the old ProctorDetailsModal)
  // ---------------------------------------------------------------------
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

  // NDA-signing artifacts live in the non-public nda-signing bucket, which also holds
  // templates/signatures/certificates for every other proctor -- minting the signed
  // URL (and authorizing that this caller may see this proctor's documents at all,
  // admin/coordinator any proctor, vendor only their own) now happens server-side in
  // proctor-document-url rather than via a direct, broadly-grantable client storage
  // call. `downloadName` sets Content-Disposition via Supabase's `download` option, so
  // whatever the admin saves it as is named for the person who signed it, not the
  // internal session-scoped storage path.
  const openSignedDocument = async (docKey: string, downloadName?: string) => {
    try {
      const data = await invokeEdgeFunction<{ url: string }>('proctor-document-url', {
        action: 'view',
        proctorId: proctor.id,
        docKey,
        downloadName,
      });
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (error: any) {
      showAlert('Could not open this file: ' + error.message, { tone: 'error' });
    }
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
  // proctor prop locally so the drawer reflects the change immediately without
  // waiting for a refetch; the underlying proctors query is still invalidated so a
  // reopen (or the table behind it) picks it up too.
  const [docOverrides, setDocOverrides] = useState<Record<string, string | null>>({});
  const [docActionKind, setDocActionKind] = useState<string | null>(null);
  const getDocValue = (key: string) => (key in docOverrides ? docOverrides[key] : (proctor as any)[key]);

  // Request/confirm, not a direct client upload -- mirrors nda-session-upload-url's
  // own shape exactly. proctor-document-url mints the signed upload URL (admin-only,
  // checked server-side) and only *that* URL ever sees the file's bytes; confirm then
  // records the new path and logs the audit event server-side once the PUT succeeds.
  const replaceDocMutation = useMutation({
    mutationFn: async ({ key, file }: { key: string; file: File }) => {
      setDocActionKind(key);
      const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';

      const requestData = await invokeEdgeFunction<{ path: string; signedUrl: string }>('proctor-document-url', {
        action: 'replace-request',
        proctorId: proctor.id,
        docKey: key,
        fileExt: ext,
      });

      const putResponse = await fetch(requestData.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putResponse.ok) throw new Error('Upload failed');

      await invokeEdgeFunction('proctor-document-url', {
        action: 'replace-confirm',
        proctorId: proctor.id,
        docKey: key,
        path: requestData.path,
      });

      setDocOverrides((prev) => ({ ...prev, [key]: requestData.path }));
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

  // Only meaningful once a proctor is Active (has a pid) -- proctor_certifications
  // is keyed by that assigned id, not the internal proctors.id UUID, matching
  // CertificationsPage's own writes to this table.
  const { data: certifications } = useQuery({
    queryKey: ['proctor-certifications', proctor.pid],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctor_certifications')
        .select('customer_name, version_certified, certified_date')
        .eq('proctor_id', proctor.pid)
        .eq('status', 'certified')
        .order('certified_date', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!proctor.pid,
  });

  const docsSubmitted = proctor.final_form_status === 'submitted';

  // The real gating order (matches checkOnboardingDocsEligibility server-side: both
  // evaluations must pass before NDA/docs ever get sent) -- NDA & Documents is one
  // step, not two, since they're sent and completed together as a single dispatch.
  const PIPELINE_STEPS = [
    { label: 'Submitted', done: proctor.form_status === 'submitted' || proctor.interview_stage !== 'interview_selected' },
    { label: 'Demo', done: demoOk },
    { label: 'Assessment', done: assessOk },
    { label: 'NDA & Documents', done: ndaSigned && docsSubmitted },
    { label: 'Verified', done: proctor.status === 'Verified' || proctor.status === 'Active' },
    { label: 'Active', done: proctor.status === 'Active' },
  ];
  const completedStepCount = PIPELINE_STEPS.filter((s) => s.done).length;
  const allStepsDone = completedStepCount === PIPELINE_STEPS.length;
  const currentStepIdx = allStepsDone ? PIPELINE_STEPS.length - 1 : completedStepCount;
  const currentStepNumber = currentStepIdx + 1;

  // The only real in-drawer actions -- Verify/Activate -- kept as plain buttons
  // (no descriptive banner/recommendation card; the progress bar above already
  // shows what stage a proctor is at).
  const canVerify = (isAdmin || isVendor) && currentStepIdx === 4 && !allStepsDone;
  const canActivate = isAdmin && currentStepIdx === 5 && !allStepsDone;
  const uploadedDocCount = docs.filter((d) => getDocValue(d.key)).length;

  // ---------------------------------------------------------------------
  // Edit-mode state (unchanged from the old EditProctorModal)
  // ---------------------------------------------------------------------
  const { data: vendorOptions = [] } = useVendorOptions();
  const { formData, setField } = useFormState({
    name: proctor.name || '',
    // Aadhaar is stored only as a one-way hash -- there's nothing to prefill.
    // Left blank, it's excluded from the save payload so the existing hash is
    // untouched; typing a new 12-digit value here overwrites it.
    aadhaar: '',
    dob: proctor.dob || '',
    gender: proctor.gender || '',
    ptype: proctor.ptype || '',
    vendor: proctor.vendor || '',
    phone: proctor.phone || '',
    email: proctor.email || '',
    city: proctor.city || '',
    state: proctor.state || '',
    notes: proctor.notes || '',
  });
  const submitEdit = () => {
    if (!isAdmin) return;
    if (!formData.name.trim()) return showAlert('Name is required', { tone: 'error' });
    if (formData.aadhaar && !/^\d{12}$/.test(formData.aadhaar)) return showAlert('Aadhaar must be exactly 12 digits', { tone: 'error' });
    if (formData.phone && !/^\d{10}$/.test(formData.phone)) return showAlert('Mobile number must be exactly 10 digits', { tone: 'error' });
    if (formData.email && !formData.email.includes('@')) return showAlert('Email address is not valid', { tone: 'error' });

    const { aadhaar, ...rest } = formData;
    onSave({
      ...rest,
      // dob is a date column -- '' (the <input type="date"> empty state, which is
      // also what a proctor with no DOB on file prefills to, e.g. one created via
      // Interview Selects before their actual onboarding form is submitted) isn't a
      // valid date and would fail the update outright; null is the correct "no DOB"
      // value.
      dob: formData.dob || null,
      // Omit entirely when left blank -- an empty string would overwrite the
      // existing hash instead of leaving it unchanged.
      ...(aadhaar ? { aadhaar } : {}),
      vendor: formData.vendor as any,
    });
  };

  return (
    <Drawer
      isOpen={true}
      widthClassName="w-full sm:w-[400px] lg:w-[440px]"
      onClose={onClose}
      title={
        mode === 'edit' ? (
          `Edit ${proctor.name}`
        ) : (
          <span className="flex items-center gap-3">
            <Avatar name={proctor.name} size="lg" />
            <span className="truncate">{proctor.name}</span>
          </span>
        )
      }
      subtitle={mode === 'view' ? [proctor.pid || 'Not assigned yet', proctor.vendor, proctor.ptype].filter(Boolean).join(' · ') : undefined}
      headerExtra={
        mode === 'view' && isAdmin ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit proctor"
              title="Edit"
              className="text-text3 hover:text-text hover:bg-surface2 rounded-md p-1.5 transition-colors"
            >
              <Pencil className="w-4 h-4" />
            </button>
            {onOffboard && proctor.status === 'Active' && (
              <button
                type="button"
                onClick={() => onOffboard(proctor)}
                aria-label="Offboard proctor"
                title="Offboard"
                // Tinted red by default (not just on hover) -- this is a destructive,
                // one-way action, so it should read as "visible and distinct" next
                // to the plain Edit icon, not blend in until hovered.
                className="flex items-center gap-1 text-danger bg-danger/10 hover:bg-danger/20 border border-danger/20 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors flex-shrink-0"
              >
                <UserX className="w-3.5 h-3.5" />
                Offboard
              </button>
            )}
          </div>
        ) : undefined
      }
    >
      {mode === 'edit' ? (
        <div className="space-y-4">
          {!isAdmin && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-warning text-sm">
              Only administrators can edit proctors.
            </div>
          )}

          <FormSection title="Personal Details">
            <div className="grid grid-cols-1 gap-4">
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
            <div className="grid grid-cols-1 gap-4">
              <SelectField
                label="Vendor"
                value={formData.vendor}
                onChange={(vendor) => setField('vendor', vendor as Proctor['vendor'])}
                options={['', ...vendorOptions.map((option) => option.value)]}
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
            <Button variant="ghost" onClick={onCancelEdit}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitEdit} disabled={isSaving || !isAdmin}>
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <Badge status={proctor.status} />
              <span className="text-[12px] font-semibold text-text2">
                Step {currentStepNumber} of {PIPELINE_STEPS.length}: {allStepsDone ? 'Active' : PIPELINE_STEPS[currentStepIdx].label}
              </span>
            </div>
            <div className="flex gap-1">
              {PIPELINE_STEPS.map((step, idx) => {
                // 3-state, not just done/not-done -- solid accent for a completed
                // stage, amber for the one currently in progress, gray for what's
                // still ahead, so the bar itself reads as "what stage is this at"
                // without needing the checklist that used to sit below it.
                const segmentClass =
                  step.done ? 'bg-accent' : idx === currentStepIdx && !allStepsDone ? 'bg-warning' : 'bg-surface2';
                // A styled hover label (same group/group-hover pattern as
                // StatusLegend) instead of the native `title` attribute --
                // consistent look with the rest of the app, and doesn't make the
                // user wait out the browser's default tooltip delay on a bar
                // that's only 6px tall.
                return (
                  <div key={step.label} className="relative group flex-1">
                    <div className={`h-1.5 rounded-full ${segmentClass}`} />
                    <div className="pointer-events-none absolute hidden group-hover:block top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded-md bg-surface border border-border2 shadow-lg text-[10px] font-semibold text-text whitespace-nowrap z-20">
                      {step.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* No icons here (unlike other UnderlineTabs usages) -- this drawer is
              narrower than a full page, and 4 labels plus a live count already need
              the space; the labels alone are unambiguous. */}
          <UnderlineTabs
            options={[
              { label: 'Overview', value: 'overview' },
              { label: `Documents (${uploadedDocCount})`, value: 'documents' },
              { label: 'Evaluations', value: 'evaluations' },
              { label: 'Activity', value: 'activity' },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === 'overview' && (
            <div className="space-y-5">
              <DetailSection title="Personal Details">
                <FieldRow label="Email Address" value={proctor.email || '—'} />
                <FieldRow label="Phone Number" value={formatPhone(proctor.phone)} />
                <FieldRow label="Date of Birth" value={proctor.dob || '—'} />
                <FieldRow label="Gender" value={proctor.gender || '—'} />
                <FieldRow label="Aadhaar" value={aadhaarStatus(proctor.aadhaar)} />
                <FieldRow label="Location" value={[proctor.city, proctor.state].filter(Boolean).join(', ') || '—'} />
                {/* Collected on the onboarding form (address is required there) but
                    never surfaced anywhere in the admin view until now. */}
                <FieldRow label="Address" value={proctor.address || '—'} className="sm:col-span-2" />
              </DetailSection>

              {proctor.notes && (
                <DetailSection title="Notes">
                  <p className="sm:col-span-2 text-[13px] text-text whitespace-pre-wrap">{proctor.notes}</p>
                </DetailSection>
              )}

              {(canVerify || canActivate) && (
                <div className="flex justify-end gap-2 pt-2 border-t border-border">
                  {canVerify && (
                    <Button variant="success" onClick={() => verifyMutation.mutate()} disabled={verifyMutation.isPending}>
                      {verifyMutation.isPending ? 'Verifying...' : 'Verify'}
                    </Button>
                  )}
                  {canActivate && (
                    <Button variant="success" onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending}>
                      {assignMutation.isPending ? 'Activating...' : 'Activate'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'documents' && (
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
                            onClick={() => openSignedDocument(doc.key, signerFileName(proctor.email, doc.key.replace(/^doc_/, '').replace(/_/g, '-'), value, proctor.id))}
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
                                  if (file) replaceDocMutation.mutate({ key: doc.key, file });
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
                      onClick={() => openSignedDocument('nda_file_url', signerFileName(proctor.email, 'nda', proctor.nda_file_url!, proctor.id))}
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
          )}

          {activeTab === 'evaluations' && <ProctorEvaluationsTab proctorId={proctor.id} certifications={certifications} />}

          {activeTab === 'activity' && <ProctorActivityTab proctor={proctor} />}
        </div>
      )}
    </Drawer>
  );
}

/** Real evaluation attempt history (demo + assessment), not just the current/latest
 * values Requirement Status shows -- every scheduled/completed attempt for this
 * proctor, newest first, plus (per user request) the certifications a now-active
 * proctor holds -- both are "track record" information, so they live on the same
 * tab rather than splitting certifications off into Overview. */
function ProctorEvaluationsTab({
  proctorId,
  certifications,
}: {
  proctorId: string;
  certifications?: { customer_name: string; version_certified: number; certified_date: string | null }[];
}) {
  const { data: evaluations = [], isLoading } = useQuery({
    queryKey: ['proctor-evaluations-history', proctorId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctor_evaluations')
        .select('id, eval_type, panel_user, scheduled_date, scheduled_time, attempt_number, result, comment, score_obtained, score_out_of')
        .eq('proctor_id', proctorId)
        .order('scheduled_date', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  // Demo/Assessment attempts are the consistent, bounded part of this tab -- shown
  // first. Certifications are a growing list (a proctor can be certified for many
  // customers over time), so it goes below, in its own capped/scrollable section
  // rather than pushing the tab's height out further as it grows.
  const certifiedFor = !!certifications?.length && (
    <DetailSection title={`Certified For (${certifications.length})`}>
      <div className="sm:col-span-2 max-h-40 overflow-y-auto divide-y divide-border -my-1">
        {certifications.map((c, i) => (
          <div key={`${c.customer_name}-${i}`} className="flex items-center justify-between gap-3 py-2">
            <span className="text-[12px] text-text font-medium truncate">{c.customer_name}</span>
            <span className="text-[11px] text-text3 flex-shrink-0">
              v{c.version_certified} · {c.certified_date ? formatDate(c.certified_date) : '—'}
            </span>
          </div>
        ))}
      </div>
    </DetailSection>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-5 h-5 text-accent animate-spin" />
      </div>
    );
  }

  if (evaluations.length === 0) {
    return (
      <div className="space-y-5">
        <div className="text-center py-10 text-text3 text-sm">No demo or assessment sessions scheduled yet.</div>
        {certifiedFor}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        {evaluations.map((ev) => (
          <div key={ev.id} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[12.5px] font-bold text-text capitalize">
                {ev.eval_type} · Attempt #{ev.attempt_number}
              </span>
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                  ev.result === 'Pass'
                    ? 'bg-success/10 text-success'
                    : ev.result
                      ? 'bg-danger/10 text-danger'
                      : 'bg-surface2 text-text3'
                }`}
              >
                {ev.result || 'Pending'}
              </span>
            </div>
            <div className="text-[11.5px] text-text3">
              {formatDate(ev.scheduled_date)}
              {ev.scheduled_time ? ` · ${ev.scheduled_time}` : ''} · Panel: {ev.panel_user}
              {ev.score_obtained != null && ` · Score: ${ev.score_obtained}${ev.score_out_of ? `/${ev.score_out_of}` : ''}`}
            </div>
            {ev.comment && <div className="text-[11.5px] text-text2 mt-1">{ev.comment}</div>}
          </div>
        ))}
      </div>
      {certifiedFor}
    </div>
  );
}

/** A per-proctor activity feed -- every audit_log row logged against this proctor's
 * name (every logAudit(...) call in this file already tags `target: proctor.name`),
 * so this is real history, not a placeholder. Timeline's 3 summary fields stay up
 * top since they're a useful one-glance answer ("when was this created/touched")
 * the full feed below doesn't replace. */
function ProctorActivityTab({ proctor }: { proctor: Proctor }) {
  const { data: activity = [], isLoading } = useQuery({
    queryKey: ['proctor-activity', proctor.name],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('ts, usr, action, detail')
        .eq('target', proctor.name)
        .order('ts', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as { ts: string; usr: string | null; action: string; detail: string }[];
    },
  });

  return (
    <div className="space-y-5">
      <DetailSection title="Timeline">
        <FieldRow label="Created By" value={`${proctor.by_user || '—'} · ${formatDate(proctor.at)}`} />
        <FieldRow label="Last Updated" value={formatDate(proctor.upd)} />
        <FieldRow label="Activated" value={proctor.aat ? formatDate(proctor.aat) : '—'} />
      </DetailSection>

      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-text3 mb-3">Activity Log</h3>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
        ) : activity.length === 0 ? (
          <div className="text-center py-10 text-text3 text-sm">No logged activity for this proctor yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {activity.map((row, idx) => (
              <div key={idx} className="py-2.5 flex gap-2.5">
                <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[12px] text-text2 leading-relaxed">
                    <span className="font-semibold text-text">{row.action}</span>
                    {row.detail ? ` — ${row.detail}` : ''}
                  </div>
                  <div className="text-[10.5px] text-text3 mt-0.5">
                    {formatDate(row.ts)} {row.usr ? `· ${row.usr}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
    // min-w-0 is required here -- a grid item's default min-width is "auto," which
    // refuses to shrink below an unbreakable string's full intrinsic width (a long
    // email/phone with no spaces to wrap at), so without this the value spills into
    // the next column instead of wrapping inside its own.
    <div className={`min-w-0 ${className}`}>
      <div className="text-[10px] uppercase tracking-wide text-text3 mb-0.5">{label}</div>
      <div className={`text-[13px] text-text break-words ${mono ? 'font-mono' : ''}`}>{value}</div>
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
