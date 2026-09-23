import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, ClipboardList, User, Upload, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import EmptyState from '@/components/ui/EmptyState';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import CompactSegmentedTabs from '@/components/ui/CompactSegmentedTabs';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import { logAudit } from '@/services/audit';
import { downloadCsv, EXPORT_ROW_CAP } from '@/lib/csv';
import { downloadBlob } from '@/lib/download';
import {
  buildCertificationWorkbook,
  parseCertificationWorkbook,
  classifyCertificationRows,
  type CertificationRow,
  type ClassifiedCertificationRow,
  type EligibleProctorRef,
} from '@/utils/certificationXlsx';
import { localDateString } from '@/utils/formatters';
import { orIlikeFilter } from '@/utils/postgrest';
import { useActiveProctorsForCert } from '@/hooks/useActiveProctorsForCert';
import { useCursorPaginatedQuery } from '@/hooks/useCursorPaginatedQuery';
import { useVendorOptions } from '@/hooks/useVendorOptions';
import DataTable from '@/components/ui/DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import type { Proctor } from '@/types';

interface Customer {
  id: string;
  name: string;
  current_version: number;
  org_id?: string;
  session_type?: string[];
  created_at?: string;
  created_by?: string;
}

interface Certification {
  id: string;
  proctor_id: string;
  customer_id: string;
  status: string;
  version_certified: number;
  certified_date: string;
  certified_by: string;
}

/** One row of the `certification_registry` view (migration 0043) -- a proctor with
 * >=1 still-valid certification (version_certified >= the customer's current
 * current_version), with those certifications pre-grouped server-side. Replaces a
 * client-side group-by-proctor join that couldn't be paginated correctly (a page
 * boundary would split one proctor's own certifications across pages instead of
 * splitting between proctors). */
interface RegistryRow {
  pid: string;
  name: string;
  vendor: string;
  ptype: string;
  verified_date: string | null;
  activated_date: string | null;
  customer_ids: string[];
  certifications: { customer_id: string; customer_name: string; certified_date: string | null; version_certified: number }[];
}

export default function CertificationsPage() {
  const { user } = useAuthStore();
  const isVendor = user?.role === 'vendor';
  const [activeTab, setActiveTab] = useState(0);

  // Vendors only ever view the registry (which of their proctors are certified for
  // which customers, to check availability against a customer requirement) -- actually
  // certifying a proctor stays admin/coordinator-only, so there's nothing for a Certify
  // tab to do here; skip the switcher entirely rather than show a tab that leads nowhere.
  if (isVendor) {
    return <RegistryTab />;
  }

  return (
    <div>
      {/* Main Tabs */}
      <div className="mb-6">
        <UnderlineTabs
          options={[
            { label: 'Certify', value: 0, icon: GraduationCap },
            { label: 'Registry', value: 1, icon: ClipboardList },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Tab Content */}
      {activeTab === 0 && <CertifyTab />}
      {activeTab === 1 && <RegistryTab />}
    </div>
  );
}

function CertifyTab() {
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [subTab, setSubTab] = useState(0);
  // Set by whichever sub-tab currently has an in-progress action (a proctor
  // mid-edit in Individual, or an uploaded-but-not-yet-certified review pending in
  // Bulk) -- locks the Customer dropdown so it can't be changed out from under that
  // work, which would otherwise let proctors/evidence chosen for one customer end up
  // certified against a different one.
  const [hasPendingWork, setHasPendingWork] = useState(false);

  // Fetch customers
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;
      return data as Customer[];
    },
    // Reference data, not something edited from this page -- CustomersPage's own
    // mutations invalidate the same ['customers'] key on write, so an actual add/
    // edit there still shows up immediately; this only skips refetching on every
    // mount/window-refocus for an otherwise-unchanged list.
    staleTime: 5 * 60_000,
  });

  const selectedCust = customers.find(c => c.id === selectedCustomer);

  const customerSelect = (
    <Select
      options={[
        { value: '', label: 'Select customer...' },
        ...customers.map(c => ({
          value: c.id,
          label: `${c.name} (SOP v${c.current_version})`,
        })),
      ]}
      value={selectedCustomer}
      onChange={(e) => setSelectedCustomer(e.target.value)}
      disabled={hasPendingWork}
      title={hasPendingWork ? 'Finish or clear the in-progress certification before switching customers' : undefined}
    />
  );

  // Nothing picked yet -- a centered prompt (not a left-aligned label+dropdown row)
  // since there's genuinely nothing else on the page until a customer is chosen.
  if (!selectedCustomer) {
    return (
      <div className="max-w-sm mx-auto pt-12">
        <EmptyState
          icon={GraduationCap}
          title="Select a Customer to Begin"
          message="Choose a customer from the dropdown to view eligible proctors for SOP certification."
        />
        {customerSelect}
      </div>
    );
  }

  return (
    <div>
      {/* Customer Selection */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-xs font-semibold text-text mb-1">Customer</label>
          {customerSelect}
        </div>
      </div>

      {/* Customer Info Banner */}
      {selectedCust && (
        <div className="bg-info/10 border border-info/30 rounded-lg p-3 mb-4 text-xs text-info">
          Customer: <strong>{selectedCust.name}</strong> · SOP Version: <strong>v{selectedCust.current_version}</strong>
          {selectedCust.org_id && <> · Org ID: <strong>{selectedCust.org_id}</strong></>}
        </div>
      )}

      {/* Sub Tabs - only show after customer selected */}
      {selectedCustomer && (
        <>
          <div className="mb-4">
            <CompactSegmentedTabs
              options={[
                { label: 'Individual', value: 0, icon: User },
                { label: 'Bulk', value: 1, icon: Upload },
              ]}
              value={subTab}
              onChange={setSubTab}
            />
          </div>

          {subTab === 0 ? (
            <IndividualCertify customer={selectedCust!} onPendingChange={setHasPendingWork} />
          ) : (
            <BulkCertify customer={selectedCust!} customers={customers} onPendingChange={setHasPendingWork} />
          )}
        </>
      )}
    </div>
  );
}

function IndividualCertify({ customer, onPendingChange }: { customer: Customer; onPendingChange: (pending: boolean) => void }) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedProctor, setSelectedProctor] = useState<Proctor | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [evidenceError, setEvidenceError] = useState('');

  // A selected proctor is "in-progress" evidence for *this* customer -- report it up
  // so the Customer dropdown locks until it's certified or cleared. The cleanup
  // (unmount, e.g. switching to the Bulk sub-tab) always clears the lock too.
  useEffect(() => {
    onPendingChange(!!selectedProctor);
    return () => onPendingChange(false);
  }, [selectedProctor, onPendingChange]);

  // Fetch active proctors with PID
  const { data: proctors = [] } = useActiveProctorsForCert();

  // Fetch existing certifications for this customer
  const { data: existingCerts = [] } = useQuery({
    queryKey: ['certifications', customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctor_certifications')
        .select('*')
        .eq('customer_id', customer.id)
        .eq('status', 'certified');

      if (error) throw error;
      return data as Certification[];
    },
  });

  const certMutation = useMutation({
    mutationFn: async (proctor: Proctor) => {
      if (!candidateId.trim() || !sectionId.trim()) {
        setEvidenceError('Candidate ID and Section ID are both required');
        throw new Error('Validation failed');
      }
      setEvidenceError('');

      const now = localDateString();
      const resultUrl = `https://recruit.talview.com/recruiter/invites/${candidateId.trim()}/assessment-section/${sectionId.trim()}/answers`;
      const body = {
        id: crypto.randomUUID(),
        proctor_id: proctor.pid!,
        customer_id: customer.id,
        customer_name: customer.name,
        status: 'certified',
        version_certified: customer.current_version,
        certified_date: now,
        certified_by: user?.username || user?.email || 'unknown',
        candidate_id: candidateId.trim(),
        section_id: sectionId.trim(),
        result_url: resultUrl,
      };

      const { error } = await supabase
        .from('proctor_certifications')
        .upsert(body, { onConflict: 'proctor_id,customer_id' });

      if (error) throw error;

      await logAudit({
        action: 'Client Certified',
        target: proctor.name,
        detail: `Certified for ${customer.name} · Candidate ID: ${candidateId.trim()} · Section ID: ${sectionId.trim()} · by ${user?.username || user?.name || 'system'}`,
        user: user?.username || user?.name || null,
      });
    },
    onSuccess: () => {
      showAlert('Proctor certified successfully!', { tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['certifications'] });
      setSelectedProctor(null);
      setSearch('');
      setCandidateId('');
      setSectionId('');
    },
    onError: (error: any) => {
      if (error.message !== 'Validation failed') {
        showAlert('Failed to certify: ' + error.message, { tone: 'error' });
      }
    },
  });

  const filteredProctors = proctors.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (p.name || '').toLowerCase().includes(s) ||
      (p.pid || '').toLowerCase().includes(s)
    );
  });

  const certifiedPIDs = new Set(existingCerts.map(c => c.proctor_id));

  return (
    <div className="bg-surface border border-border rounded-lg p-5 max-w-[560px]">
      {/* Search */}
      <div className="mb-3">
        <label className="block text-xs font-semibold text-text mb-1">
          Search Proctor (by name or ID)
        </label>
        <Input
          placeholder="Type name or PID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Proctor List */}
      <div className="mb-4">
        <DataTable
          data={filteredProctors}
          emptyMessage="No active proctors found"
          onRowClick={(proctor) => !certifiedPIDs.has(proctor.pid!) && setSelectedProctor(proctor)}
          rowClassName={(proctor) => {
            const alreadyCertified = certifiedPIDs.has(proctor.pid!);
            if (selectedProctor?.id === proctor.id) return 'bg-accent/10';
            if (alreadyCertified) return 'opacity-50 cursor-not-allowed';
            return '';
          }}
          columns={[
            {
              id: 'proctor',
              header: 'Proctor',
              enableSorting: false,
              cell: ({ row }) => (
                <div>
                  <div className="text-xs font-semibold text-text">{row.original.name}</div>
                  <div className="text-[10px] text-text3">
                    PID: {row.original.pid} · {row.original.vendor} · {row.original.ptype}
                  </div>
                </div>
              ),
            },
            {
              id: 'certified',
              header: '',
              enableSorting: false,
              meta: { className: 'text-right' },
              cell: ({ row }) =>
                certifiedPIDs.has(row.original.pid!) ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-success">
                    <CheckCircle2 className="w-3 h-3" /> Certified
                  </span>
                ) : null,
            },
          ] satisfies ColumnDef<Proctor, any>[]}
        />
      </div>

      {/* Selected Proctor */}
      {selectedProctor && !certifiedPIDs.has(selectedProctor.pid!) && (
        <div className="mb-4">
          <div className="p-3 bg-accent/10 border border-accent/30 rounded-lg mb-3 text-xs font-semibold text-accent">
            Selected: {selectedProctor.name} ({selectedProctor.pid})
          </div>
          <div className="grid grid-cols-2 gap-3 mb-1">
            <div>
              <label className="block text-[11px] font-semibold text-text2 mb-1">
                Candidate ID <span className="text-danger">*</span>
              </label>
              <Input placeholder="e.g. 12345" value={candidateId} onChange={(e) => { setCandidateId(e.target.value); setEvidenceError(''); }} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text2 mb-1">
                Section ID <span className="text-danger">*</span>
              </label>
              <Input placeholder="e.g. 67890" value={sectionId} onChange={(e) => { setSectionId(e.target.value); setEvidenceError(''); }} />
            </div>
          </div>
          {evidenceError && <div className="text-danger text-xs mb-2">{evidenceError}</div>}
        </div>
      )}

      {/* Certify Button */}
      <Button
        variant="success"
        disabled={!selectedProctor || certifiedPIDs.has(selectedProctor.pid!) || certMutation.isPending}
        onClick={() => selectedProctor && certMutation.mutate(selectedProctor)}
      >
        <CheckCircle2 className="w-4 h-4" /> Certify Proctor
      </Button>
    </div>
  );
}

/** No manual selection step -- "eligible" already means "every active,
 * PID-assigned proctor not yet certified for this customer," so Download
 * Template just downloads all of them, fresh, every click. Blank rows
 * (Candidate ID and Section ID both empty) are the expected common case and
 * are simply never touched; only rows with something in either field get
 * reviewed and (if valid) certified. See classifyCertificationRows for the
 * exact per-row rules. */
function BulkCertify({
  customer,
  customers,
  onPendingChange,
}: {
  customer: Customer;
  customers: Customer[];
  onPendingChange: (pending: boolean) => void;
}) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [processing, setProcessing] = useState(false);
  // null = no file uploaded yet (still on the "download" step); once set, holds
  // every row from the uploaded file (blanks included) so an inline fix can be
  // re-classified against the full original set, not just the flagged subset.
  const [classified, setClassified] = useState<ClassifiedCertificationRow[] | null>(null);
  const [certifiedResults, setCertifiedResults] = useState<Record<string, 'success' | 'failed'>>({});
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const { data: proctors = [], isLoading: proctorsLoading } = useActiveProctorsForCert();
  const { data: existingCerts = [], isLoading: certsLoading } = useQuery({
    queryKey: ['certifications', customer.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proctor_certifications')
        .select('*')
        .eq('customer_id', customer.id)
        .eq('status', 'certified');
      if (error) throw error;
      return data as Certification[];
    },
  });
  // Never let an admin act (download or upload) while either query is still
  // loading -- certifiedPIDs briefly reading as empty mid-load is exactly what
  // silently over-counted "eligible" before (a proctor who turns out to already
  // be certified would flash through as eligible, then vanish once this
  // resolved, with nothing selected-and-lost this time since there's no
  // standing selection to drop -- but downloading during that window would
  // still bake a stale, too-large eligible list into the file).
  const isLoadingEligibility = proctorsLoading || certsLoading;

  const certifiedPIDs = new Set(existingCerts.map((c) => c.proctor_id));
  const eligibleProctors = proctors.filter((p) => !certifiedPIDs.has(p.pid!));
  const eligibleRefs: EligibleProctorRef[] = eligibleProctors.map((p) => ({ id: p.id, pid: p.pid || '', name: p.name || '' }));
  const eligibleById = new Map(eligibleProctors.map((p) => [p.id, p]));

  // Locks the Customer dropdown from the moment a file is uploaded until "Start
  // Over" -- covers the review step and the post-certify results view alike, not
  // just the brief upload-to-certify window.
  useEffect(() => {
    onPendingChange(classified !== null);
    return () => onPendingChange(false);
  }, [classified, onPendingChange]);

  const handleDownloadTemplate = async () => {
    const rows: CertificationRow[] = eligibleProctors.map((p) => ({
      proctorId: p.id,
      pid: p.pid || '',
      proctorName: p.name || '',
      email: p.email || '',
      vendor: p.vendor || '',
      ptype: p.ptype || '',
      candidateId: null,
      sectionId: null,
    }));
    const blob = await buildCertificationWorkbook({ id: customer.id, name: customer.name, currentVersion: customer.current_version }, rows);
    downloadBlob(`bulk_certify_${customer.name.replace(/\s+/g, '_')}_${localDateString()}.xlsx`, blob);
  };

  const handleUploadCompleted = async (file: File) => {
    try {
      const { customerId, rows } = await parseCertificationWorkbook(file);
      // The file itself says which customer it was generated for -- refuse
      // outright if that doesn't match whoever is currently selected, rather
      // than silently certifying proctors picked under a different customer
      // against this one.
      if (customerId && customerId !== customer.id) {
        const otherCustomer = customers.find((c) => c.id === customerId);
        showAlert(
          `This file was downloaded for ${otherCustomer ? otherCustomer.name : 'a different customer'} -- select that customer first, or download a fresh template for ${customer.name}.`,
          { tone: 'error' }
        );
        return;
      }
      const result = classifyCertificationRows(rows, eligibleRefs);
      if (result.every((r) => r.status === 'blank')) {
        showAlert('Every row in that file was left blank -- nothing to certify.', { tone: 'error' });
        return;
      }
      setClassified(result);
      setCertifiedResults({});
    } catch (err: any) {
      showAlert(err.message || 'Could not read that file', { tone: 'error' });
    }
  };

  // Re-runs classification against the *current* eligible set (not a frozen
  // snapshot) whenever a flagged row is fixed inline -- so a fix that resolves
  // the flag actually moves that row into "to certify" immediately.
  const updateFlaggedRow = (proctorId: string, field: 'candidateId' | 'sectionId', value: string) => {
    setClassified((prev) => {
      if (!prev) return prev;
      const rawRows = prev.map((r) => (r.proctorId === proctorId ? { ...r, [field]: value } : r));
      return classifyCertificationRows(
        rawRows.map((r) => ({ proctorId: r.proctorId, candidateId: r.candidateId, sectionId: r.sectionId })),
        eligibleRefs
      );
    });
  };

  const toCertifyRows = (classified ?? []).filter((r) => r.status === 'to_certify');
  const flaggedRows = (classified ?? []).filter((r) => r.status !== 'to_certify' && r.status !== 'blank');
  const blankCount = (classified ?? []).filter((r) => r.status === 'blank').length;
  const hasResults = Object.keys(certifiedResults).length > 0;

  const handleCertifyAll = async () => {
    if (toCertifyRows.length === 0) {
      showAlert('Nothing is ready to certify -- resolve the flagged rows first, or upload a completed file.', { tone: 'error' });
      return;
    }
    const ok = await showConfirm(`Certify ${toCertifyRows.length} proctor${toCertifyRows.length === 1 ? '' : 's'} for ${customer.name}?`, {
      title: 'Bulk certify',
      confirmLabel: 'Certify',
    });
    if (!ok) return;

    setProcessing(true);
    const now = localDateString();
    const results: Record<string, 'success' | 'failed'> = {};

    for (const row of toCertifyRows) {
      const proctor = row.proctor!;
      const resultUrl = `https://recruit.talview.com/recruiter/invites/${row.candidateId}/assessment-section/${row.sectionId}/answers`;
      try {
        const { error } = await supabase.from('proctor_certifications').upsert(
          {
            id: crypto.randomUUID(),
            proctor_id: proctor.pid,
            customer_id: customer.id,
            customer_name: customer.name,
            status: 'certified',
            version_certified: customer.current_version,
            certified_date: now,
            certified_by: user?.username || user?.email || 'unknown',
            candidate_id: row.candidateId,
            section_id: row.sectionId,
            result_url: resultUrl,
          },
          { onConflict: 'proctor_id,customer_id' }
        );
        if (error) throw error;

        await logAudit({
          action: 'Client Certified',
          target: proctor.name,
          detail: `Certified (bulk) for ${customer.name} · Candidate ID: ${row.candidateId} · Section ID: ${row.sectionId} · by ${user?.username || user?.name || 'system'}`,
          user: user?.username || user?.name || null,
        });
        results[row.proctorId] = 'success';
      } catch {
        results[row.proctorId] = 'failed';
      }
    }

    setCertifiedResults(results);
    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ['certifications'] });
  };

  const startOver = () => {
    setClassified(null);
    setCertifiedResults({});
  };

  if (isLoadingEligibility) {
    return (
      <div className="bg-surface border border-border rounded-lg p-5 max-w-[720px] flex items-center justify-center py-12 text-text3">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading eligible proctors…
      </div>
    );
  }

  if (classified === null) {
    return (
      <div className="bg-surface border border-border rounded-lg p-5 max-w-[720px]">
        <p className="text-text2 text-xs mb-4">
          <strong>{eligibleProctors.length}</strong> proctor{eligibleProctors.length === 1 ? '' : 's'} currently eligible for{' '}
          <strong>{customer.name}</strong> (active, PID-assigned, not already certified).
        </p>
        <div className="flex items-center gap-2 mb-2">
          <Button variant="primary" size="sm" onClick={handleDownloadTemplate} disabled={eligibleProctors.length === 0}>
            <Download className="w-3.5 h-3.5" /> Download Template
          </Button>
          <Button variant="ghost" size="sm" onClick={() => uploadInputRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> Upload Completed File
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUploadCompleted(file);
              e.target.value = '';
            }}
          />
        </div>
        <p className="text-[11px] text-text3">
          Fill in Candidate ID and Section ID for whichever proctors you want to certify -- leave the rest blank, nothing happens to them -- then upload the file back.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5 max-w-[720px]">
      <div className="flex items-center justify-between mb-4">
        <p className="text-text2 text-xs">
          <strong className="text-success">{toCertifyRows.length}</strong> will be certified
          {flaggedRows.length > 0 && (
            <>
              {' '}
              · <strong className="text-warning">{flaggedRows.length}</strong> flagged
            </>
          )}
          {blankCount > 0 && <> · {blankCount} left blank</>}
        </p>
        <Button variant="ghost" size="sm" onClick={startOver}>Start Over</Button>
      </div>

      {flaggedRows.length > 0 && (
        <div className="mb-4">
          <div className="text-[11px] font-bold text-warning uppercase tracking-wide mb-1.5">Needs attention</div>
          <div className="space-y-2">
            {flaggedRows.map((row) => (
              <div key={row.proctorId} className="border border-warning/30 bg-warning/5 rounded-lg p-2.5">
                <div className="text-xs font-semibold text-text mb-1">
                  {eligibleById.get(row.proctorId)?.name || 'Unrecognized proctor'}
                </div>
                <div className="text-[11px] text-warning mb-2">{row.reason}</div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="Candidate ID"
                    value={row.candidateId}
                    onChange={(e) => updateFlaggedRow(row.proctorId, 'candidateId', e.target.value)}
                    disabled={hasResults}
                  />
                  <Input
                    placeholder="Section ID"
                    value={row.sectionId}
                    onChange={(e) => updateFlaggedRow(row.proctorId, 'sectionId', e.target.value)}
                    disabled={hasResults}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {toCertifyRows.length > 0 && (
        <div className="mb-4">
          <DataTable
            data={toCertifyRows}
            columns={[
              {
                id: 'proctor',
                header: 'Proctor',
                enableSorting: false,
                cell: ({ row }) => (
                  <>
                    <div className="font-semibold text-text">{row.original.proctor?.name}</div>
                    <div className="text-[10px] text-text3">PID: {row.original.proctor?.pid}</div>
                  </>
                ),
              },
              { id: 'candidate_id', header: 'Candidate ID', enableSorting: false, cell: ({ row }) => row.original.candidateId },
              { id: 'section_id', header: 'Section ID', enableSorting: false, cell: ({ row }) => row.original.sectionId },
              {
                id: 'status',
                header: 'Status',
                enableSorting: false,
                cell: ({ row }) => {
                  const result = certifiedResults[row.original.proctorId];
                  return result === 'success' ? (
                    <span className="inline-flex items-center gap-1 text-success font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Certified</span>
                  ) : result === 'failed' ? (
                    <span className="text-danger font-bold">Failed</span>
                  ) : (
                    <span className="text-text3">Pending</span>
                  );
                },
              },
            ] satisfies ColumnDef<ClassifiedCertificationRow, any>[]}
          />
        </div>
      )}

      {!hasResults ? (
        <Button variant="success" disabled={toCertifyRows.length === 0 || processing} onClick={handleCertifyAll}>
          <CheckCircle2 className="w-4 h-4" /> Certify {toCertifyRows.length} Proctor{toCertifyRows.length === 1 ? '' : 's'}
        </Button>
      ) : (
        <Button variant="ghost" onClick={startOver}>Done</Button>
      )}
    </div>
  );
}

function RegistryTab() {
  const { user } = useAuthStore();
  const isVendor = user?.role === 'vendor';
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 25;
  const CUSTOMER_PILLS_VISIBLE = 3;
  const { data: vendorOptions = [] } = useVendorOptions();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch customers -- still needed in full for the "All Customers" dropdown (a
  // small reference table, not a pagination target).
  const { data: customers = [], isLoading: customersLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;
      return data as Customer[];
    },
    // Reference data, not something edited from this page -- CustomersPage's own
    // mutations invalidate the same ['customers'] key on write, so an actual add/
    // edit there still shows up immediately; this only skips refetching on every
    // mount/window-refocus for an otherwise-unchanged list.
    staleTime: 5 * 60_000,
  });

  // Registry itself: one row per proctor with >=1 still-valid certification, already
  // grouped/aggregated server-side by the certification_registry view (migration
  // 0043) -- see that migration for why this couldn't be a plain client-side group-by
  // over a paginated fetch (a page boundary would split one proctor's own
  // certifications across pages instead of splitting between proctors).
  const {
    data: registryRows,
    isLoading: registryLoading,
    isFetching,
    hasNextPage,
    hasPreviousPage,
    goToNextPage,
    goToPreviousPage,
    pageIndex,
  } = useCursorPaginatedQuery<RegistryRow>({
    queryKey: ['certification-registry', vendorFilter, customerFilter],
    table: 'certification_registry',
    filters: (q) => {
      let query = q;
      if (vendorFilter) query = query.eq('vendor', vendorFilter);
      if (customerFilter) query = query.contains('customer_ids', [customerFilter]);
      return query;
    },
    searchColumns: ['name', 'pid'],
    searchTerm: debouncedSearch,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'name', ascending: true },
    // certification_registry (migration 0043) is a view keyed by pid, not id.
    idColumn: 'pid',
    resetKey: `${vendorFilter}|${customerFilter}`,
  });

  const isLoading = registryLoading || customersLoading;

  const exportRegistry = async () => {
    // Exports every matching row, not just the current page -- re-runs the same
    // filters against the view, mirroring ProctorsPage/OffboardedPage's own
    // export-at-click-time pattern, bounded by EXPORT_ROW_CAP instead of an
    // unbounded fetch.
    let query = supabase.from('certification_registry').select('*').order('name', { ascending: true });
    if (vendorFilter) query = query.eq('vendor', vendorFilter);
    if (customerFilter) query = query.contains('customer_ids', [customerFilter]);
    if (debouncedSearch.trim()) {
      const term = debouncedSearch.trim();
      query = query.or(orIlikeFilter(['name', 'pid'], term));
    }
    const { data, error } = await query.range(0, EXPORT_ROW_CAP);
    if (error) return showAlert('Failed to export: ' + error.message, { tone: 'error' });

    const rows = (data ?? []) as RegistryRow[];
    const truncated = rows.length > EXPORT_ROW_CAP;

    downloadCsv(
      `certification_registry_${localDateString()}.csv`,
      ['Proctor ID', 'Name', 'Type', 'Vendor', 'Certified Customers', 'Certified Dates', 'Verified Date', 'Activated Date'],
      rows.slice(0, EXPORT_ROW_CAP).map((r) => [
        r.pid,
        r.name,
        r.ptype,
        r.vendor,
        r.certifications.map((c) => c.customer_name).join(', '),
        r.certifications.map((c) => `${c.customer_name}: ${c.certified_date || '—'}`).join('; '),
        r.verified_date || '',
        r.activated_date || '',
      ])
    );
    if (truncated) {
      showAlert(
        `Export capped at ${EXPORT_ROW_CAP.toLocaleString()} rows -- narrow your filters to get a complete export.`,
        { tone: 'error' }
      );
    }
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Name, ID..."
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
            { value: '', label: 'All Customers' },
            ...customers.map(c => ({ value: c.id, label: c.name })),
          ]}
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          wrapperClassName="min-w-[180px]"
        />
        <ClearFiltersButton
          show={!!(search || vendorFilter || customerFilter)}
          onClick={() => {
            setSearch('');
            setVendorFilter('');
            setCustomerFilter('');
          }}
        />
        <Button variant="ghost" size="sm" onClick={exportRegistry}>
          <Download className="w-4 h-4" /> Export
        </Button>
      </div>

      {/* Table */}
      <DataTable
        data={registryRows}
        isLoading={isLoading}
        emptyMessage="No certified proctors found"
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
          { id: 'pid', header: 'Proctor ID', enableSorting: false, cell: ({ row }) => row.original.pid, meta: { className: 'font-mono text-[11px] text-text3' } },
          { id: 'name', header: 'Name', enableSorting: false, cell: ({ row }) => row.original.name, meta: { className: 'text-[13px] text-text font-semibold' } },
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
          { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-[12px] text-text2' } },
          {
            id: 'certified_customers',
            header: 'Certified Customers',
            enableSorting: false,
            cell: ({ row }) => {
              const reg = row.original;
              const names = reg.certifications.map((c) => c.customer_name);
              return (
                <div className="flex flex-wrap items-center gap-1 max-w-[420px]">
                  {(expandedRows.has(reg.pid) ? names : names.slice(0, CUSTOMER_PILLS_VISIBLE)).map((name: string, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-info/10 text-info text-[11px] font-medium whitespace-nowrap">
                      {name}
                    </span>
                  ))}
                  {names.length > CUSTOMER_PILLS_VISIBLE && (
                    <button
                      onClick={() => setExpandedRows(prev => {
                        const next = new Set(prev);
                        if (next.has(reg.pid)) next.delete(reg.pid);
                        else next.add(reg.pid);
                        return next;
                      })}
                      className="text-[11px] font-semibold text-accent hover:underline whitespace-nowrap"
                    >
                      {expandedRows.has(reg.pid) ? 'Show less' : `+${names.length - CUSTOMER_PILLS_VISIBLE} more`}
                    </button>
                  )}
                </div>
              );
            },
          },
        ] satisfies ColumnDef<RegistryRow, any>[]}
      />
    </div>
  );
}
