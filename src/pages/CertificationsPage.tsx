import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, ClipboardList, User, Upload, CheckCircle2, Download } from 'lucide-react';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import CompactSegmentedTabs from '@/components/ui/CompactSegmentedTabs';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import { logAudit } from '@/services/audit';
import { downloadCsv } from '@/lib/csv';
import { useActiveProctorsForCert } from '@/hooks/useActiveProctorsForCert';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { useManagedByOptions } from '@/hooks/useManagedByOptions';
import Table from '@/components/ui/Table';
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
  });

  const selectedCust = customers.find(c => c.id === selectedCustomer);

  return (
    <div>
      {/* Customer Selection */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-xs font-semibold text-text mb-1">Customer</label>
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
          />
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
            <IndividualCertify customer={selectedCust!} />
          ) : (
            <BulkCertify customer={selectedCust!} />
          )}
        </>
      )}
    </div>
  );
}

function IndividualCertify({ customer }: { customer: Customer }) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedProctor, setSelectedProctor] = useState<Proctor | null>(null);
  const [candidateId, setCandidateId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [evidenceError, setEvidenceError] = useState('');

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

      const now = new Date().toISOString().slice(0, 10);
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
        <Table
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
              header: 'Proctor',
              accessor: (proctor) => (
                <div>
                  <div className="text-xs font-semibold text-text">{proctor.name}</div>
                  <div className="text-[10px] text-text3">
                    PID: {proctor.pid} · {proctor.managed_by || proctor.vendor} · {proctor.ptype}
                  </div>
                </div>
              ),
            },
            {
              header: '',
              className: 'text-right',
              accessor: (proctor) =>
                certifiedPIDs.has(proctor.pid!) ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-success">
                    <CheckCircle2 className="w-3 h-3" /> Certified
                  </span>
                ) : null,
            },
          ]}
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

interface EvidenceRow {
  candidateId: string;
  sectionId: string;
  result?: 'success' | 'failed';
  resultError?: string;
}

function BulkCertify({ customer }: { customer: Customer }) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'select' | 'evidence'>('select');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState<Record<string, EvidenceRow>>({});
  const [processing, setProcessing] = useState(false);

  const { data: proctors = [] } = useActiveProctorsForCert();

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
  const certifiedPIDs = new Set(existingCerts.map((c) => c.proctor_id));

  const eligibleProctors = proctors.filter((p) => !certifiedPIDs.has(p.pid!));
  const filteredProctors = eligibleProctors.filter((p) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (p.name || '').toLowerCase().includes(s) || (p.pid || '').toLowerCase().includes(s);
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedProctors = eligibleProctors.filter((p) => selectedIds.has(p.id));

  const goToEvidence = () => {
    if (selectedIds.size === 0) return;
    setEvidence((prev) => {
      const next = { ...prev };
      selectedProctors.forEach((p) => {
        if (!next[p.id]) next[p.id] = { candidateId: '', sectionId: '' };
      });
      return next;
    });
    setPhase('evidence');
  };

  const updateEvidence = (proctorId: string, field: 'candidateId' | 'sectionId', value: string) => {
    setEvidence((prev) => ({ ...prev, [proctorId]: { ...prev[proctorId], [field]: value } }));
  };

  const readyCount = selectedProctors.filter((p) => evidence[p.id]?.candidateId.trim() && evidence[p.id]?.sectionId.trim()).length;
  const hasResults = selectedProctors.some((p) => evidence[p.id]?.result);

  const handleCertifyAll = async () => {
    const rows = selectedProctors.filter((p) => evidence[p.id]?.candidateId.trim() && evidence[p.id]?.sectionId.trim());
    if (rows.length === 0) {
      showAlert('Enter Candidate ID and Section ID for at least one proctor', { tone: 'error' });
      return;
    }
    const ok = await showConfirm(`Certify ${rows.length} of ${selectedProctors.length} selected proctors for ${customer.name}?`, {
      title: 'Bulk certify',
      confirmLabel: 'Certify',
    });
    if (!ok) return;

    setProcessing(true);
    const now = new Date().toISOString().slice(0, 10);

    for (const proctor of rows) {
      const ev = evidence[proctor.id];
      const resultUrl = `https://recruit.talview.com/recruiter/invites/${ev.candidateId.trim()}/assessment-section/${ev.sectionId.trim()}/answers`;
      try {
        const { error } = await supabase.from('proctor_certifications').upsert(
          {
            id: crypto.randomUUID(),
            proctor_id: proctor.pid!,
            customer_id: customer.id,
            customer_name: customer.name,
            status: 'certified',
            version_certified: customer.current_version,
            certified_date: now,
            certified_by: user?.username || user?.email || 'unknown',
            candidate_id: ev.candidateId.trim(),
            section_id: ev.sectionId.trim(),
            result_url: resultUrl,
          },
          { onConflict: 'proctor_id,customer_id' }
        );
        if (error) throw error;

        await logAudit({
          action: 'Client Certified',
          target: proctor.name,
          detail: `Certified (bulk) for ${customer.name} · Candidate ID: ${ev.candidateId.trim()} · Section ID: ${ev.sectionId.trim()} · by ${user?.username || user?.name || 'system'}`,
          user: user?.username || user?.name || null,
        });

        setEvidence((prev) => ({ ...prev, [proctor.id]: { ...prev[proctor.id], result: 'success' } }));
      } catch (err: any) {
        setEvidence((prev) => ({ ...prev, [proctor.id]: { ...prev[proctor.id], result: 'failed', resultError: err.message } }));
      }
    }

    setProcessing(false);
    queryClient.invalidateQueries({ queryKey: ['certifications'] });
  };

  const reset = () => {
    setPhase('select');
    setSelectedIds(new Set());
    setEvidence({});
    setSearch('');
  };

  if (phase === 'select') {
    return (
      <div className="bg-surface border border-border rounded-lg p-5 max-w-[600px]">
        <p className="text-text2 text-xs mb-3">
          Select the proctors to certify for <strong>{customer.name}</strong>, then provide each one's evidence.
        </p>
        <Input
          placeholder="Search name or PID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName="mb-3"
        />
        <div className="mb-4">
          <Table
            data={filteredProctors}
            emptyMessage="No eligible proctors found"
            onRowClick={(proctor) => toggleSelect(proctor.id)}
            columns={[
              {
                header: '',
                className: 'w-8',
                accessor: (proctor) => (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(proctor.id)}
                    onChange={() => toggleSelect(proctor.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-4 h-4 accent-accent"
                  />
                ),
              },
              {
                header: 'Proctor',
                accessor: (proctor) => (
                  <div>
                    <div className="text-xs font-semibold text-text">{proctor.name}</div>
                    <div className="text-[10px] text-text3">
                      PID: {proctor.pid} · {proctor.managed_by || proctor.vendor} · {proctor.ptype}
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </div>
        <Button variant="success" disabled={selectedIds.size === 0} onClick={goToEvidence}>
          Continue with {selectedIds.size} proctor{selectedIds.size === 1 ? '' : 's'}
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5 max-w-[720px]">
      <div className="flex items-center justify-between mb-3">
        <p className="text-text2 text-xs">
          Provide Candidate ID and Section ID for each proctor. {readyCount}/{selectedProctors.length} ready.
        </p>
        <Button variant="ghost" size="sm" onClick={reset}>Back to selection</Button>
      </div>
      <div className="mb-4">
        <Table
          data={selectedProctors}
          columns={[
            {
              header: 'Proctor',
              accessor: (proctor) => (
                <>
                  <div className="font-semibold text-text">{proctor.name}</div>
                  <div className="text-[10px] text-text3">PID: {proctor.pid}</div>
                </>
              ),
            },
            {
              header: 'Candidate ID',
              accessor: (proctor) => {
                const ev = evidence[proctor.id] || { candidateId: '', sectionId: '' };
                return (
                  <Input
                    placeholder="Candidate ID"
                    value={ev.candidateId}
                    onChange={(e) => updateEvidence(proctor.id, 'candidateId', e.target.value)}
                    disabled={!!ev.result}
                  />
                );
              },
            },
            {
              header: 'Section ID',
              accessor: (proctor) => {
                const ev = evidence[proctor.id] || { candidateId: '', sectionId: '' };
                return (
                  <Input
                    placeholder="Section ID"
                    value={ev.sectionId}
                    onChange={(e) => updateEvidence(proctor.id, 'sectionId', e.target.value)}
                    disabled={!!ev.result}
                  />
                );
              },
            },
            {
              header: 'Status',
              accessor: (proctor) => {
                const ev = evidence[proctor.id] || { candidateId: '', sectionId: '' };
                return ev.result === 'success' ? (
                  <span className="inline-flex items-center gap-1 text-success font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Certified</span>
                ) : ev.result === 'failed' ? (
                  <span className="text-danger font-bold" title={ev.resultError}>Failed</span>
                ) : (
                  <span className="text-text3">Pending</span>
                );
              },
            },
          ]}
        />
      </div>
      {!hasResults ? (
        <Button variant="success" disabled={readyCount === 0 || processing} onClick={handleCertifyAll}>
          <CheckCircle2 className="w-4 h-4" /> Certify {readyCount} Proctor{readyCount === 1 ? '' : 's'}
        </Button>
      ) : (
        <Button variant="ghost" onClick={reset}>Done</Button>
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
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const CUSTOMER_PILLS_VISIBLE = 3;
  const { data: managedByOptions = [] } = useManagedByOptions();

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
  });

  // Registry itself: one row per proctor with >=1 still-valid certification, already
  // grouped/aggregated server-side by the certification_registry view (migration
  // 0043) -- see that migration for why this couldn't be a plain client-side group-by
  // over a paginated fetch (a page boundary would split one proctor's own
  // certifications across pages instead of splitting between proctors).
  const { data: pageResult, isLoading: registryLoading, isFetching } = usePaginatedQuery<RegistryRow>({
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
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'name', ascending: true },
  });

  const registryRows = pageResult?.data ?? [];
  const totalCount = pageResult?.count ?? 0;
  const isLoading = registryLoading || customersLoading;

  const exportRegistry = async () => {
    // Exports every matching row, not just the current page -- re-runs the same
    // filters against the view with no .range(), mirroring ProctorsPage/
    // OffboardedPage's own export-at-click-time pattern.
    let query = supabase.from('certification_registry').select('*').order('name', { ascending: true });
    if (vendorFilter) query = query.eq('vendor', vendorFilter);
    if (customerFilter) query = query.contains('customer_ids', [customerFilter]);
    if (debouncedSearch.trim()) {
      const term = debouncedSearch.trim();
      query = query.or(`name.ilike.%${term}%,pid.ilike.%${term}%`);
    }
    const { data, error } = await query;
    if (error) return showAlert('Failed to export: ' + error.message, { tone: 'error' });

    downloadCsv(
      `certification_registry_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Proctor ID', 'Name', 'Type', 'Vendor', 'Certified Customers', 'Certified Dates', 'Verified Date', 'Activated Date'],
      ((data || []) as RegistryRow[]).map((r) => [
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
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <Input
          placeholder="Name, ID..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          wrapperClassName="flex-1 min-w-[180px]"
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
        <Select
          options={[
            { value: '', label: 'All Customers' },
            ...customers.map(c => ({ value: c.id, label: c.name })),
          ]}
          value={customerFilter}
          onChange={(e) => {
            setCustomerFilter(e.target.value);
            setPage(1);
          }}
          wrapperClassName="min-w-[180px]"
        />
        <ClearFiltersButton
          show={!!(search || vendorFilter || customerFilter)}
          onClick={() => {
            setSearch('');
            setVendorFilter('');
            setCustomerFilter('');
            setPage(1);
          }}
        />
        <Button variant="ghost" size="sm" onClick={exportRegistry}>
          <Download className="w-4 h-4" /> Export
        </Button>
      </div>

      {/* Table */}
      <Table
        data={registryRows}
        isLoading={isLoading}
        emptyMessage="No certified proctors found"
        pagination={{ page, pageSize: PAGE_SIZE, count: totalCount, isFetching, onPageChange: setPage }}
        columns={[
          { header: 'Proctor ID', accessor: (row) => row.pid, className: 'font-mono text-[11px] text-text3' },
          { header: 'Name', accessor: (row) => row.name, className: 'text-[13px] text-text font-semibold' },
          {
            header: 'Type',
            accessor: (row) => (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-info/10 text-info">
                {row.ptype}
              </span>
            ),
          },
          { header: 'Vendor', accessor: (row) => row.vendor, className: 'text-[12px] text-text2' },
          {
            header: 'Certified Customers',
            accessor: (row) => {
              const names = row.certifications.map((c) => c.customer_name);
              return (
                <div className="flex flex-wrap items-center gap-1 max-w-[420px]">
                  {(expandedRows.has(row.pid) ? names : names.slice(0, CUSTOMER_PILLS_VISIBLE)).map((name: string, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-info/10 text-info text-[11px] font-medium whitespace-nowrap">
                      {name}
                    </span>
                  ))}
                  {names.length > CUSTOMER_PILLS_VISIBLE && (
                    <button
                      onClick={() => setExpandedRows(prev => {
                        const next = new Set(prev);
                        if (next.has(row.pid)) next.delete(row.pid);
                        else next.add(row.pid);
                        return next;
                      })}
                      className="text-[11px] font-semibold text-accent hover:underline whitespace-nowrap"
                    >
                      {expandedRows.has(row.pid) ? 'Show less' : `+${names.length - CUSTOMER_PILLS_VISIBLE} more`}
                    </button>
                  )}
                </div>
              );
            },
          },
        ]}
      />
    </div>
  );
}
