import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileDown, CheckCircle2, XCircle, Save, Loader2, UserPlus, Send, Trash2 } from 'lucide-react';
import { supabase, invokeEdgeFunction } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { useCursorPaginatedQuery } from '@/hooks/useCursorPaginatedQuery';
import DataTable from '@/components/ui/DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { FilterTrigger, FilterChips, type FilterFieldDef } from '@/components/ui/FilterBuilder';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import SelectionActionBar, { SelectionAction } from '@/components/ui/SelectionActionBar';
import ActionMenu from '@/components/ui/ActionMenu';
import { logAudit } from '@/services/audit';
import { parseCsv } from '@/lib/csv';
import { getScopedVendor } from '@/utils/access';
import { PROCTOR_TYPES } from '@/utils/constants';
import { useVendorOptions } from '@/hooks/useVendorOptions';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import { useUIStore } from '@/stores/ui';
import DispatchStatusCell from '@/components/ui/DispatchStatusCell';
import DispatchStatusLegend from '@/components/ui/DispatchStatusLegend';
import { createBulkDispatch, getActiveDispatchForProctors } from '@/services/bulkDispatch';
import type { Proctor, InterviewSelectFilters } from '@/types';

// Above this many recipients, confirm before firing a bulk send -- guards against an
// accidental "select all" rather than any real system limit (the worker already
// throttles actual sending to 50 items/minute regardless of how many are queued).
const LARGE_BULK_SEND_THRESHOLD = 100;

// Full literal class strings (Tailwind's JIT scanner can't see `bg-${tone}`-style
// interpolation) -- same color vocabulary as DispatchStatusCell/Legend: not sent =
// neutral, shared = accent (matches "Sent"), expired = danger, submitted = success.
const FORM_STATUS_CHIPS: { label: string; value: string; activeClass: string; dotClass?: string }[] = [
  { label: 'All Form Status', value: '', activeClass: 'bg-accent/10 text-accent border-transparent' },
  { label: 'Not Sent', value: 'not_sent', activeClass: 'bg-text3/10 text-text3 border-transparent', dotClass: 'bg-text3' },
  { label: 'Shared', value: 'shared', activeClass: 'bg-accent/10 text-accent border-transparent', dotClass: 'bg-accent' },
  { label: 'Expired', value: 'expired', activeClass: 'bg-danger/10 text-danger border-transparent', dotClass: 'bg-danger' },
  { label: 'Submitted', value: 'submitted', activeClass: 'bg-success/10 text-success border-transparent', dotClass: 'bg-success' },
];

export default function InterviewSelectsPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<InterviewSelectFilters>({ search: '', vendor: '', status: '', ptype: '' });
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search || '');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingProctor, setEditingProctor] = useState<Proctor | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvProcessing, setCsvProcessing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [bulkSummary, setBulkSummary] = useState<{ text: string; tone: 'success' | 'warning' | 'error' } | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const openBulkActivity = useUIStore((s) => s.openBulkActivity);
  // Grace window for the "Email: Sending..." poll below -- set the moment a bulk
  // send is kicked off, so the poll picks up newly-queued items even if nothing was
  // in flight (and the poll had already stopped) right before the click.
  const [dispatchedAt, setDispatchedAt] = useState<number | null>(null);
  const PAGE_SIZE = 25;

  // Debounce search so typing doesn't fire a request per keystroke now that
  // search is server-side instead of an instant client-side filter.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search || ''), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  const isVendor = user?.role === 'vendor';
  // Vendors only ever see the interview selects admin has imported under them --
  // no adding, no CSV import, no sending/resending the onboarding form. Coordinators
  // were already read-only here before this; vendor is now the same bucket.
  const isReadOnly = user?.role === 'coordinator' || isVendor;
  const isAdmin = user?.role === 'admin';
  const scopedVendor = getScopedVendor(user);
  const { data: vendorOptions = [] } = useVendorOptions();
  const managedByValues = new Set(vendorOptions.map((option) => option.value));

  // 'expired' isn't its own form_status value -- a 'shared' link becomes Expired once
  // its 24h window passes (see the Form Status column's DispatchStatusCell below), so
  // both the filter and the badge derive it from form_link_expires_at rather than
  // storing a separate status.
  const isFormLinkExpired = (p: Proctor) =>
    !!(p.form_link_expires_at && new Date(p.form_link_expires_at) < new Date());

  // Fetch interview selects -- server-side search/filter/cursor-pagination via
  // useCursorPaginatedQuery, mirroring ProctorsPage rather than fetching every
  // interview-select row and filtering/paging in the browser.
  const {
    data: pageData,
    isLoading,
    isFetching,
    hasNextPage,
    hasPreviousPage,
    goToNextPage,
    goToPreviousPage,
    pageIndex,
  } = useCursorPaginatedQuery<Proctor>({
    queryKey: ['interview-selects', user?.vendor, filters.vendor, filters.status, filters.ptype],
    table: 'proctors',
    filters: (q) => {
      let query = q.eq('interview_stage', 'interview_selected');
      // Vendor role sees only their proctors
      if (scopedVendor) query = query.eq('vendor', scopedVendor);
      if (!isVendor && filters.vendor) query = query.eq('vendor', filters.vendor);
      if (filters.ptype) query = query.eq('ptype', filters.ptype);
      // Mirrors the Form Status column's own derivation below -- 'expired'/'shared' aren't
      // distinguished by a stored column, they're form_status:'shared' whose
      // form_link_expires_at has (or hasn't) passed.
      if (filters.status) {
        const nowIso = new Date().toISOString();
        if (filters.status === 'not_sent') {
          query = query.or('form_status.is.null,form_status.eq.,form_status.eq.not_sent');
        } else if (filters.status === 'expired') {
          query = query.eq('form_status', 'shared').lt('form_link_expires_at', nowIso);
        } else if (filters.status === 'shared') {
          query = query.eq('form_status', 'shared').or(`form_link_expires_at.is.null,form_link_expires_at.gte.${nowIso}`);
        } else if (filters.status === 'submitted') {
          query = query.eq('form_status', 'submitted');
        }
      }
      return query;
    },
    searchColumns: ['email', 'name'],
    searchTerm: debouncedSearch,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'at', ascending: false },
    resetKey: `${filters.vendor}|${filters.status}|${filters.ptype}`,
    // Narrowed from select('*') -- verified against the table columns and
    // EditInterviewSelectModal, which is opened directly with a row from this page
    // (setEditingProctor(row)), not a separate per-row fetch.
    select: 'id, email, name, vendor, ptype, notes, interview_stage, form_status, form_link_expires_at, form_shared_at, form_access_count, at',
  });

  // Existence check for the Add Person modal and the CSV import's duplicate check --
  // both need to see every interview-select record (not just the current page), which
  // the paginated query above intentionally no longer fetches. Kept to a minimal
  // email/name projection since that's all either check needs. Key shares the
  // 'interview-selects' prefix so every invalidateQueries({queryKey: ['interview-selects']})
  // below (delete, bulk delete, CSV import, add person) refreshes this too, not just
  // the paginated table.
  const { data: allInterviewSelectEmails = [] } = useQuery({
    queryKey: ['interview-selects', 'emails', user?.vendor],
    queryFn: async () => {
      let query = supabase.from('proctors').select('email, name').eq('interview_stage', 'interview_selected');
      if (scopedVendor) query = query.eq('vendor', scopedVendor);
      const { data, error } = await query;
      if (error) throw error;
      return data as Pick<Proctor, 'email' | 'name'>[];
    },
  });

  // Send onboarding link mutation -- takes the full row (the caller already has it,
  // as a table row action) instead of looking it up by id from a page/filtered array
  // that may no longer contain it now that the table is server-paginated.
  const sendLinkMutation = useMutation({
    mutationFn: async (proctor: Proctor) => {
      if (!proctor.email) throw new Error('No email address');

      return invokeEdgeFunction('send-form-link', { proctorId: proctor.id });
    },
    onSuccess: async (_, proctor) => {
      await logAudit({
        action: 'Form Link Shared',
        target: proctor.email || proctor.name || proctor.id,
        detail: `Sent by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
      queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
      showAlert('Form link sent successfully! The proctor will receive an email with instructions.', { tone: 'success' });
    },
    onError: (error: any) => {
      console.error('Send form error:', error);
      showAlert('Error: ' + error.message, { tone: 'error' });
    },
  });

  // Delete a single interview select entry (admin-only, only while still at the
  // interview_stage; enforced server-side too -- see delete_interview_select). Takes
  // the full row for the same reason as sendLinkMutation above.
  const deleteMutation = useMutation({
    mutationFn: async (proctor: Proctor) => {
      const { error } = await supabase.rpc('delete_interview_select', { p_proctor_id: proctor.id });
      if (error) throw error;
    },
    onSuccess: async (_, proctor) => {
      await logAudit({
        action: 'Interview Select Deleted',
        target: proctor.email || proctor.name || proctor.id,
        detail: `Deleted by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
      queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
    },
    onError: (error: any) => {
      showAlert('Delete failed: ' + error.message, { tone: 'error' });
    },
  });

  const handleDelete = async (proctor: Proctor) => {
    const ok = await showConfirm(`Delete ${proctor.email || proctor.name}? This cannot be undone.`, {
      title: 'Delete interview select',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteMutation.mutate(proctor);
  };

  const runBulkAction = async (label: string, totalSelected: number, ids: string[], action: (id: string) => Promise<void>) => {
    const ineligible = totalSelected - ids.length;
    if (ids.length === 0) {
      setBulkSummary({ text: `${label}: none of the ${totalSelected} selected are eligible for this action`, tone: 'error' });
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
    setBulkSummary({ text: `${label}: ${parts.join(', ')}`, tone: failed ? 'error' : ineligible ? 'warning' : 'success' });
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
    setTimeout(() => setBulkSummary(null), 6000);
  };

  // Only resolves ids that are on the CURRENT PAGE -- a selected id from a previous
  // page (before paging or changing filters) simply won't be found here, matching
  // ProctorsPage's own selectedProctors, which has the identical trade-off.
  const selectedRows = pageData.filter((p) => selectedIds.has(p.id));

  // Powers the temporary "Email: Sending.../Failed [Retry]" line under the Form Status
  // badge -- polled only while something's actually in flight, and only for proctors
  // currently visible on this page, so this stays cheap. Disappears once the item
  // resolves to sent (it no longer matches 'processing'/'failed', so it just stops
  // appearing here) -- the business status badge above it is completely unaffected
  // either way.
  const visibleIds = pageData.map((p) => p.id);
  const { data: activeDispatch } = useQuery({
    queryKey: ['active-dispatch', 'send_pre_onboarding_form', visibleIds],
    queryFn: () => getActiveDispatchForProctors(visibleIds, 'send_pre_onboarding_form'),
    // bulk-dispatch-status is admin-only server-side -- gating here too avoids a
    // guaranteed-to-fail request on every poll for coordinators/vendors, both of
    // whom can reach this page (it has no route-level role restriction).
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
  // own client-side filter thinks are eligible. Mailgun sending happens afterward via
  // bulk-dispatch-worker (immediate kick + a 1-minute cron backstop), never blocking
  // this request, so it responds in well under a second regardless of selection size.
  const handleBulkSendForm = async () => {
    if (selectedIds.size === 0) return;
    if (selectedIds.size > LARGE_BULK_SEND_THRESHOLD) {
      const ok = await showConfirm(
        `You're about to send the pre-onboarding form to ${selectedIds.size} proctors. Continue?`,
        { confirmLabel: 'Send' }
      );
      if (!ok) return;
    }
    setBulkCreating(true);
    try {
      const result = await createBulkDispatch('SEND_PRE_ONBOARDING_FORM', Array.from(selectedIds));
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

  const handleBulkDelete = async () => {
    const eligible = selectedRows.filter((p) => p.interview_stage === 'interview_selected');
    const ok = await showConfirm(
      `Delete ${eligible.length} interview select${eligible.length === 1 ? '' : 's'}? This cannot be undone.`,
      { title: 'Delete interview selects', confirmLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    runBulkAction('Delete', selectedRows.length, eligible.map((p) => p.id), async (id) => {
      const { error } = await supabase.rpc('delete_interview_select', { p_proctor_id: id });
      if (error) throw error;
      // eligible rows already carry the full proctor object -- no need to look this
      // back up in a full/paginated array that may not contain every selected id.
      const proctor = eligible.find((p) => p.id === id);
      await logAudit({
        action: 'Interview Select Deleted',
        target: proctor?.email || proctor?.name || id,
        detail: `Deleted (bulk) by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    });
  };

  // Download CSV template
  const downloadTemplate = () => {
    const BOM = '\uFEFF';
    const header = 'email,vendor,ptype,notes';
    const example = '"john@gmail.com","Sai","ODP","Strong candidate"\n"jane@gmail.com","TSN","WFO",""';
    const blob = new Blob([BOM + header + '\n' + example], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'interview_selects_template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    showAlert('Template downloaded', { tone: 'success' });
  };

  // Handle CSV file upload
  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset processing state when new file is uploaded
    setCsvProcessing(false);

    const text = await file.text();
    const parsed = parseCsv(text);

    if (parsed.length < 2) {
      showAlert('File appears empty', { tone: 'error' });
      return;
    }

    const headers = parsed[0].map((h) => h.toLowerCase());
    const emailIdx = headers.indexOf('email');
    // Accepts the current template's 'vendor' header, plus 'proctors'/'managed_by' for
    // anyone still using a template downloaded before this was renamed.
    const vendorIdx =
      headers.indexOf('vendor') >= 0
        ? headers.indexOf('vendor')
        : headers.indexOf('proctors') >= 0
        ? headers.indexOf('proctors')
        : headers.indexOf('managed_by');
    const ptypeIdx = headers.indexOf('ptype');
    const notesIdx = headers.indexOf('notes');

    if (emailIdx < 0) {
      showAlert('CSV must have email column', { tone: 'error' });
      return;
    }

    // Tracks emails already seen earlier in this same file -- the DB-existence check
    // below only catches rows that collide with what's already in the system, not two
    // rows in the same upload colliding with each other, which still trips the
    // uniq_email_active constraint at insert time despite every row individually
    // looking fine against the DB.
    const seenInFile = new Set<string>();

    const rows = parsed.slice(1).map(values => {
      const email = values[emailIdx]?.trim().toLowerCase() || '';
      const vendor = values[vendorIdx]?.trim() || '';
      const ptype = values[ptypeIdx]?.trim() || '';
      const notes = notesIdx >= 0 ? values[notesIdx]?.trim() || '' : '';

      const errors: string[] = [];

      if (!email || !email.includes('@')) errors.push('Invalid email');
      if (vendor && !managedByValues.has(vendor)) errors.push('Unknown vendor: ' + vendor);
      if (!['WFO', 'ODP', 'Hybrid'].includes(ptype)) errors.push('Invalid ptype: ' + ptype);

      // Check if already exists
      const exists = allInterviewSelectEmails.find(p => p.email?.toLowerCase() === email);
      if (exists) errors.push(`Already in system (${email})`);

      if (email) {
        if (seenInFile.has(email)) errors.push('Duplicate email in this file');
        else seenInFile.add(email);
      }

      return {
        email,
        vendor,
        ptype,
        notes,
        _ok: errors.length === 0,
        _errors: errors,
        _result: undefined as 'success' | 'failed' | undefined,
        _resultError: undefined as string | undefined,
      };
    }).filter(r => r.email);

    setCsvData(rows);
  };

  // Human-readable translation for the DB errors this import can actually hit --
  // callers see the constraint name, not what it means.
  const describeInsertError = (message: string): string => {
    if (message.includes('uniq_email_active')) return 'Duplicate email (already exists)';
    return message;
  };

  // Import CSV mutation -- inserts one row at a time rather than a single batch insert,
  // so a single row hitting a DB-level conflict (e.g. a duplicate that slipped past
  // client-side validation) doesn't roll back every other row in the same file. Each
  // row's outcome is written back onto csvData as it completes, so the preview table
  // can show exactly which rows succeeded/failed and why instead of one opaque alert.
  const importMutation = useMutation({
    mutationFn: async () => {
      const validIndexes = csvData
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => r._ok);
      if (validIndexes.length === 0) {
        throw new Error('Nothing to import');
      }

      let succeeded = 0;
      let failed = 0;

      for (const { r, idx } of validIndexes) {
        const now = new Date().toISOString();
        const pid = crypto.randomUUID();
        const token = crypto.randomUUID().replace(/-/g, '');
        const row = {
          id: pid,
          pid: '',
          name: '',
          aadhaar: `PENDING_${pid.slice(0, 8)}`,
          vendor: r.vendor,
          phone: `PENDING_${pid.slice(9, 17)}`,
          email: r.email,
          address: '',
          city: '',
          state: '',
          dob: null,
          gender: '',
          ptype: r.ptype,
          bgv: '',
          nda: '',
          notes: r.notes,
          demo_eval: 'Pending',
          assessment: 'Pending',
          demo_ready: 'awaiting',
          assessment_ready: 'awaiting',
          demo_ready_attempt: 1,
          assessment_ready_attempt: 1,
          nda_status: '',
          nda_triggered_at: null,
          nda_triggered_by: '',
          nda_signed_at: null,
          nda_file_url: '',
          status: 'Interview Selected',
          stage: 0,
          interview_stage: 'interview_selected',
          form_status: 'not_sent',
          form_link_token: token,
          vendor_verified: false,
          vendor_verified_by: '',
          vendor_verified_at: null,
          by_user: user?.username || user?.email || 'system',
          at: now,
          upd: now,
          vby: '',
          vat: null,
          aat: null,
          oat: null,
          off_reason: '',
          off_notes: '',
        };

        const { error: insertError } = await supabase.from('proctors').insert(row);
        if (insertError) {
          failed += 1;
          setCsvData(prev => prev.map((row2, i) => (i === idx ? { ...row2, _result: 'failed', _resultError: describeInsertError(insertError.message) } : row2)));
        } else {
          succeeded += 1;
          setCsvData(prev => prev.map((row2, i) => (i === idx ? { ...row2, _result: 'success' } : row2)));
        }
      }

      return { succeeded, failed, total: validIndexes.length };
    },
    onSuccess: (result) => {
      setCsvProcessing(false);
      queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
      if (result.failed === 0) {
        showAlert(`${result.succeeded} interview selects imported successfully!`, { tone: 'success' });
        setShowImport(false);
        setCsvData([]);
        const fileInput = document.querySelector('input[type="file"][accept=".csv"]') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
      }
      // If some rows failed, leave the modal open with per-row results visible instead
      // of closing over an incomplete, unreviewed import.
    },
    onError: (error: any) => {
      setCsvProcessing(false);
      showAlert('Import failed: ' + error.message, { tone: 'error' });
    },
  });

  const handleConfirmImport = () => {
    const validCount = csvData.filter(r => r._ok).length;
    if (validCount === 0) {
      showAlert('Nothing to import', { tone: 'error' });
      return;
    }
    setCsvProcessing(true);
    importMutation.mutate();
  };

  const columns: ColumnDef<Proctor, any>[] = [
    {
      id: 'select',
      header: () => (
        // "Select all" adds/removes only this page's rows from whatever's already
        // selected, rather than replacing the whole selection -- a bulk send now
        // correctly covers rows picked on an earlier page too. Selecting every row
        // matching the filters across every page would still need a separate
        // un-paginated query, which this doesn't attempt.
        <input
          type="checkbox"
          checked={pageData.length > 0 && pageData.every((p) => selectedIds.has(p.id))}
          onChange={() => {
            const isFullySelected = pageData.length > 0 && pageData.every((p) => selectedIds.has(p.id));
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (isFullySelected) {
                pageData.forEach((p) => next.delete(p.id));
              } else {
                pageData.forEach((p) => next.add(p.id));
              }
              return next;
            });
          }}
          className="w-4 h-4 accent-accent cursor-pointer"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.original.id)}
          onChange={(e) => {
            const newSet = new Set(selectedIds);
            if (e.target.checked) {
              newSet.add(row.original.id);
            } else {
              newSet.delete(row.original.id);
            }
            setSelectedIds(newSet);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 accent-accent cursor-pointer"
        />
      ),
      enableSorting: false,
      meta: { className: 'w-8' },
    },
    {
      id: 'email',
      header: 'Email',
      enableSorting: false,
      cell: ({ row }) => (
        <div>
          <div className="text-[13px]">{row.original.email}</div>
          <div className="text-[11px] text-text3">{row.original.name || '—'}</div>
        </div>
      ),
    },
    {
      id: 'vendor',
      header: 'Vendor',
      enableSorting: false,
      accessorKey: 'vendor',
    },
    {
      id: 'ptype',
      header: 'Type',
      enableSorting: false,
      accessorKey: 'ptype',
    },
    {
      id: 'notes',
      header: 'Notes',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="text-[12px] text-text2 max-w-[200px] truncate">
          {row.original.notes || '—'}
        </div>
      ),
    },
    {
      id: 'form_status',
      header: () => (
        <span className="inline-flex items-center gap-1">
          Form Status
          <DispatchStatusLegend />
        </span>
      ),
      enableSorting: false,
      cell: ({ row }) => (
        <DispatchStatusCell
          flow={{
            completed: row.original.form_status === 'submitted',
            expired: row.original.form_status === 'shared' && isFormLinkExpired(row.original),
            viewed: (row.original.form_access_count ?? 0) > 0,
            lastSucceededAt: row.original.form_shared_at,
          }}
          dispatch={activeDispatchByProctor.get(row.original.id)}
        />
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      cell: ({ row }) => {
        const proctor = row.original;
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {!isReadOnly && proctor.form_status !== 'submitted' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => sendLinkMutation.mutate(proctor)}
                disabled={sendLinkMutation.isPending}
                className="!text-[11px] !px-2 !py-1"
              >
                {proctor.form_status === 'shared' ? 'Re-send Form' : 'Send Form'}
              </Button>
            )}
            {isAdmin && (
              <ActionMenu
                items={[
                  { label: 'Edit', onClick: () => setEditingProctor(proctor) },
                  { label: 'Delete', onClick: () => handleDelete(proctor), danger: true },
                ]}
              />
            )}
          </div>
        );
      },
    },
  ];

  // Form Status used to be its own always-visible chip row; now it's just another
  // field behind the same "Add Filter" builder as Vendor/Type, so the filter row
  // stays short and consistent with Proctors/Scheduled Events.
  const interviewFilterFields: FilterFieldDef[] = [
    { key: 'status', label: 'Form Status', options: FORM_STATUS_CHIPS.filter((c) => c.value).map((c) => ({ value: c.value, label: c.label })) },
    { key: 'ptype', label: 'Type', options: PROCTOR_TYPES.map((t) => ({ value: t, label: t })) },
    ...(!isVendor ? [{ key: 'vendor', label: 'Vendor', options: vendorOptions } as FilterFieldDef] : []),
  ];
  const interviewFilterValues = { status: filters.status || '', ptype: filters.ptype || '', vendor: filters.vendor || '' };
  const handleInterviewFilterChange = (key: string, value: string) => setFilters({ ...filters, [key]: value } as any);

  return (
    <div>
      {/* Filters -- flat row, no card wrapper (matches Proctors). Form Status/Type/
          Vendor all live behind one "Add Filter" builder, with applied chips on
          their own row below so adding one never reflows this row. */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Input
            placeholder="Search name, email..."
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            wrapperClassName="w-[220px]"
          />

          <FilterTrigger fields={interviewFilterFields} values={interviewFilterValues} onChange={handleInterviewFilterChange} />

          <ClearFiltersButton
            show={!!(filters.search || filters.vendor || filters.status || filters.ptype)}
            onClick={() => setFilters({ search: '', vendor: '', status: '', ptype: '' })}
          />
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!isReadOnly && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAddPerson(true)}
              >
                <UserPlus className="w-3.5 h-3.5" /> Add
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowImport(true)}
              >
                <FileDown className="w-3.5 h-3.5" /> Import CSV
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mb-3">
        <FilterChips fields={interviewFilterFields} values={interviewFilterValues} onChange={handleInterviewFilterChange} />
      </div>

      {/* Table */}
      <DataTable
        data={pageData}
        columns={columns}
        isLoading={isLoading}
        // Matches the Edit action's own gating below -- only admin can edit an
        // interview select at all, so the row itself is only clickable for admin.
        onRowClick={isAdmin ? setEditingProctor : undefined}
        emptyMessage="No interview selects — import a CSV to get started"
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
              <span>{bulkProgress.label}: {bulkProgress.done}/{bulkProgress.total}</span>
            </div>
          ) : (
            <div
              className={`text-sm font-medium ${
                bulkSummary?.tone === 'success' ? 'text-success' : bulkSummary?.tone === 'warning' ? 'text-warning' : 'text-danger'
              }`}
            >
              {bulkSummary?.text}
            </div>
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <SelectionActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          {!isReadOnly && (
            <SelectionAction
              icon={Send}
              label={bulkCreating ? 'Starting…' : 'Send Form'}
              onClick={handleBulkSendForm}
              disabled={!!bulkProgress || bulkCreating}
            />
          )}
          {isAdmin && (
            <SelectionAction
              icon={Trash2}
              iconClassName="text-danger"
              label="Delete"
              onClick={handleBulkDelete}
              disabled={!!bulkProgress}
            />
          )}
        </SelectionActionBar>
      )}


      {/* Edit Modal */}
      {editingProctor && (
        <EditInterviewSelectModal
          proctor={editingProctor}
          onClose={() => setEditingProctor(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
            setEditingProctor(null);
          }}
        />
      )}

      {/* Add Person Modal */}
      {showAddPerson && (
        <AddInterviewSelectModal
          existing={allInterviewSelectEmails}
          onClose={() => setShowAddPerson(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['interview-selects'] });
            setShowAddPerson(false);
          }}
        />
      )}

      {/* Import Modal */}
      {showImport && (
        <Modal
          isOpen={true}
          onClose={() => {
            setShowImport(false);
            setCsvData([]);
            setCsvProcessing(false); // Reset processing state
          }}
          title="Import Interview Selects"
          size="lg"
        >
          <div className="space-y-4">
            <p className="text-text2 text-xs">
              CSV columns: <code className="bg-surface2 px-1.5 py-0.5 rounded text-[10px]">email, proctors, ptype, notes</code>
            </p>

            <Button variant="ghost" size="sm" onClick={downloadTemplate}>
              <Download className="w-3.5 h-3.5" /> Download Template
            </Button>

            {/* Upload Zone */}
            <label className="block cursor-pointer">
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-accent transition-colors">
                <FileDown className="w-8 h-8 text-text3 mx-auto mb-2" />
                <p className="text-sm text-text mb-1">
                  <span className="text-accent font-semibold">Click to upload</span> interview selects CSV
                </p>
              </div>
              <input
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                className="hidden"
              />
            </label>

            {/* Preview */}
            {csvData.length > 0 && (() => {
              const hasResults = csvData.some(r => r._result);
              const succeededCount = csvData.filter(r => r._result === 'success').length;
              const failedCount = csvData.filter(r => r._result === 'failed').length;
              return (
              <div>
                {hasResults ? (
                  <div className={`p-3 rounded-lg mb-3 text-xs ${failedCount > 0 ? 'bg-warning/10 border border-warning/30 text-warning' : 'bg-success/10 border border-success/30 text-success'}`}>
                    <strong>{succeededCount}</strong> imported
                    {failedCount > 0 && <> · <strong>{failedCount}</strong> failed (skipped, rest still imported)</>}
                  </div>
                ) : (
                  <div className={`p-3 rounded-lg mb-3 text-xs ${
                    csvData.filter(r => !r._ok).length > 0
                      ? 'bg-warning/10 border border-warning/30 text-warning'
                      : 'bg-info/10 border border-info/30 text-info'
                  }`}>
                    <strong>{csvData.filter(r => r._ok).length}</strong> to import ·
                    <strong> {csvData.filter(r => !r._ok).length}</strong> error(s)
                  </div>
                )}

                {csvData.filter(r => !r._ok).length > 0 && (
                  <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 mb-3 text-xs text-danger space-y-1">
                    {csvData.filter(r => !r._ok).map((r, i) => (
                      <div key={i}>
                        <strong>{r.email}</strong> — {r._errors.join(', ')}
                      </div>
                    ))}
                  </div>
                )}

                <DataTable
                  data={csvData}
                  columns={[
                    { id: 'email', header: 'Email', enableSorting: false, cell: ({ row }) => row.original.email },
                    { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor },
                    { id: 'ptype', header: 'Type', enableSorting: false, cell: ({ row }) => row.original.ptype },
                    {
                      id: 'status',
                      header: 'Status',
                      enableSorting: false,
                      cell: ({ row }) => {
                        const csvRow = row.original;
                        return csvRow._result === 'success' ? (
                          <span className="inline-flex items-center gap-1 text-success text-[10px] font-bold">
                            <CheckCircle2 className="w-3 h-3" /> Imported
                          </span>
                        ) : csvRow._result === 'failed' ? (
                          <span className="inline-flex items-center gap-1 text-danger text-[10px] font-bold" title={csvRow._resultError}>
                            <XCircle className="w-3 h-3" /> Failed — {csvRow._resultError}
                          </span>
                        ) : csvRow._ok && csvProcessing ? (
                          <span className="inline-flex items-center gap-1 text-text3 text-[10px] font-bold">
                            <Loader2 className="w-3 h-3 animate-spin" /> Importing...
                          </span>
                        ) : csvRow._ok ? (
                          <span className="inline-flex items-center gap-1 text-success text-[10px] font-bold">
                            <CheckCircle2 className="w-3 h-3" /> OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-danger text-[10px] font-bold">
                            <XCircle className="w-3 h-3" /> Error
                          </span>
                        );
                      },
                    },
                  ] satisfies ColumnDef<any, any>[]}
                />

                <div className="flex gap-2 mt-4">
                  {!hasResults && (
                    <Button
                      variant="success"
                      disabled={csvData.filter(r => r._ok).length === 0 || csvProcessing}
                      onClick={handleConfirmImport}
                    >
                      <CheckCircle2 className="w-4 h-4" /> Import All Valid
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowImport(false);
                      setCsvData([]);
                      setCsvProcessing(false); // Reset processing state
                    }}
                  >
                    {hasResults ? 'Done' : 'Cancel'}
                  </Button>
                </div>
              </div>
              );
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
}

interface EditInterviewSelectModalProps {
  proctor: Proctor;
  onClose: () => void;
  onSuccess: () => void;
}

function EditInterviewSelectModal({ proctor, onClose, onSuccess }: EditInterviewSelectModalProps) {
  const [email, setEmail] = useState(proctor.email || '');
  const [vendor, setVendor] = useState(proctor.vendor || '');
  const [ptype, setPtype] = useState(proctor.ptype || '');
  const [notes, setNotes] = useState(proctor.notes || '');
  const [emailError, setEmailError] = useState('');
  const { data: vendorOptions = [] } = useVendorOptions();

  // Validate email on change
  const validateEmail = (value: string) => {
    if (value && !value.includes('@')) {
      setEmailError('Enter valid email');
    } else {
      setEmailError('');
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const trimmedEmail = email.trim().toLowerCase();
      
      // Validate
      if (!trimmedEmail || !trimmedEmail.includes('@')) {
        throw new Error('Enter a valid email address');
      }
      if (!vendor) {
        throw new Error('Vendor is required');
      }
      if (!ptype) {
        throw new Error('Proctor Type is required');
      }

      // Check email uniqueness (skip own record)
      if (trimmedEmail !== proctor.email?.toLowerCase()) {
        const { data: duplicates, error: checkError } = await supabase
          .from('proctors')
          .select('id, name')
          .neq('id', proctor.id)
          .ilike('email', trimmedEmail);

        if (checkError) throw checkError;

        if (duplicates && duplicates.length > 0) {
          throw new Error(`Email already exists for ${duplicates[0].name}`);
        }
      }

      // Update proctor
      const { error } = await supabase
        .from('proctors')
        .update({
          email: trimmedEmail,
          vendor,
          ptype,
          notes,
          upd: new Date().toISOString(),
        })
        .eq('id', proctor.id);

      if (error) throw error;
    },
    onSuccess: () => {
      showAlert('Interview select updated successfully', { tone: 'success' });
      onSuccess();
    },
    onError: (error: any) => {
      if (error.message.includes('Email already exists')) {
        setEmailError(error.message);
      } else {
        showAlert('Save failed: ' + error.message, { tone: 'error' });
      }
    },
  });

  return (
    <Modal isOpen={true} onClose={onClose} title="Edit Interview Select">
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Email <span className="text-danger">*</span>
          </label>
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              validateEmail(e.target.value);
            }}
            placeholder="proctor@gmail.com"
          />
          {emailError && (
            <div className="text-[11px] text-danger mt-1">{emailError}</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1">
              Vendor <span className="text-danger">*</span>
            </label>
            <Select
              options={[
                { value: '', label: 'Select...' },
                ...vendorOptions,
              ]}
              value={vendor}
              onChange={(e) => setVendor(e.target.value as Proctor['vendor'])}
            />
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-text mb-1">
              Proctor Type <span className="text-danger">*</span>
            </label>
            <Select
              options={[
                { value: '', label: 'Select...' },
                ...PROCTOR_TYPES.map((t) => ({ value: t, label: t })),
              ]}
              value={ptype}
              onChange={(e) => setPtype(e.target.value as Proctor['ptype'])}
            />
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any relevant info about this candidate..."
            rows={2}
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-[13px] text-text outline-none focus:border-accent resize-none"
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

interface AddInterviewSelectModalProps {
  // Just enough to duplicate-check a new email against every existing interview
  // select -- not the full row, and not paginated, since this check needs to see
  // every record regardless of what's currently on screen in the main table.
  existing: Pick<Proctor, 'email' | 'name'>[];
  onClose: () => void;
  onSuccess: () => void;
}

/** Adds a single Interview Selects entry directly, without needing a CSV round-trip. */
function AddInterviewSelectModal({ existing, onClose, onSuccess }: AddInterviewSelectModalProps) {
  const { user } = useAuthStore();
  const [email, setEmail] = useState('');
  const [vendor, setVendor] = useState('');
  const [ptype, setPtype] = useState('');
  const [notes, setNotes] = useState('');
  const [emailError, setEmailError] = useState('');
  const { data: vendorOptions = [] } = useVendorOptions();
  const scopedVendor = getScopedVendor(user);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail || !trimmedEmail.includes('@')) throw new Error('Enter a valid email address');
      if (!vendor) throw new Error('Vendor is required');
      if (!ptype) throw new Error('Proctor Type is required');

      const dupe = existing.find((p) => p.email?.toLowerCase() === trimmedEmail);
      if (dupe) throw new Error(`Email already exists for ${dupe.name || dupe.email}`);

      const now = new Date().toISOString();
      const pid = crypto.randomUUID();
      const token = crypto.randomUUID().replace(/-/g, '');
      const row = {
        id: pid,
        pid: '',
        name: '',
        aadhaar: `PENDING_${pid.slice(0, 8)}`,
        vendor,
        phone: `PENDING_${pid.slice(9, 17)}`,
        email: trimmedEmail,
        address: '',
        city: '',
        state: '',
        dob: null,
        gender: '',
        ptype,
        bgv: '',
        nda: '',
        notes,
        demo_eval: 'Pending',
        assessment: 'Pending',
        demo_ready: 'awaiting',
        assessment_ready: 'awaiting',
        demo_ready_attempt: 1,
        assessment_ready_attempt: 1,
        nda_status: '',
        nda_triggered_at: null,
        nda_triggered_by: '',
        nda_signed_at: null,
        nda_file_url: '',
        status: 'Interview Selected',
        stage: 0,
        interview_stage: 'interview_selected',
        form_status: 'not_sent',
        form_link_token: token,
        vendor_verified: false,
        vendor_verified_by: '',
        vendor_verified_at: null,
        by_user: user?.username || user?.email || 'system',
        at: now,
        upd: now,
        vby: '',
        vat: null,
        aat: null,
        oat: null,
        off_reason: '',
        off_notes: '',
      };

      const { error } = await supabase.from('proctors').insert(row);
      if (error) throw error;

      await logAudit({
        action: 'Interview Select Added',
        target: trimmedEmail,
        detail: `Added by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    },
    onSuccess: () => {
      showAlert('Interview select added successfully', { tone: 'success' });
      onSuccess();
    },
    onError: (error: any) => {
      if (error.message.includes('Email already exists')) {
        setEmailError(error.message);
      } else {
        showAlert('Add failed: ' + error.message, { tone: 'error' });
      }
    },
  });

  return (
    <Modal isOpen={true} onClose={onClose} title="Add Interview Select">
      <div className="space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">
            Email <span className="text-danger">*</span>
          </label>
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError('');
            }}
            placeholder="proctor@gmail.com"
            autoFocus
          />
          {emailError && <div className="text-[11px] text-danger mt-1">{emailError}</div>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1">
              Vendor <span className="text-danger">*</span>
            </label>
            <Select
              options={[
                { value: '', label: 'Select...' },
                ...vendorOptions,
              ]}
              value={vendor || scopedVendor || ''}
              onChange={(e) => setVendor(e.target.value)}
              disabled={!!scopedVendor}
            />
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-text mb-1">
              Proctor Type <span className="text-danger">*</span>
            </label>
            <Select
              options={[
                { value: '', label: 'Select...' },
                ...PROCTOR_TYPES.map((t) => ({ value: t, label: t })),
              ]}
              value={ptype}
              onChange={(e) => setPtype(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-text mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any relevant info about this candidate..."
            rows={2}
            className="w-full px-3 py-2 bg-surface2 border border-border rounded-lg text-[13px] text-text outline-none focus:border-accent resize-none"
          />
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            <UserPlus className="w-4 h-4" /> Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}
