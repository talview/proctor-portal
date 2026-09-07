import { useEffect, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, Undo2, ArrowUp, ArrowDown, ArrowRight, UserMinus, History } from 'lucide-react';
import UnderlineTabs from '@/components/ui/UnderlineTabs';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { getScopedVendor } from '@/utils/access';
import { useManagedByOptions } from '@/hooks/useManagedByOptions';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import { downloadCsv } from '@/lib/csv';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import Table from '@/components/ui/Table';
import type { Proctor, OffboardedFilters } from '@/types';

export default function OffboardedPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState(0);
  const [filters, setFilters] = useState<OffboardedFilters>({ search: '', vendor: '' });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyVendorFilter, setHistoryVendorFilter] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const { data: managedByOptions = [] } = useManagedByOptions();

  const isAdmin = user?.role === 'admin';
  const isVendor = user?.role === 'vendor';
  const scopedVendor = getScopedVendor(user);

  // Debounce search so typing doesn't fire a request per keystroke now that
  // search is server-side instead of an instant client-side filter.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search || ''), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  // Fetch offboarded proctors (tab 0, flat list) -- server-side paginated,
  // searched and vendor-filtered (was a flat fetch-all with client-side
  // filtering; see IncompletePage's identical scoping for the OR pattern below).
  const { data: pageResult, isLoading: isLoadingOffboarded, isFetching: isFetchingOffboarded } = usePaginatedQuery<Proctor>({
    queryKey: ['offboarded-proctors', user?.vendor, filters.vendor],
    table: 'proctors',
    filters: (q) => {
      let query = q.eq('status', 'Offboarded');

      // Vendor role sees only their proctors. Previously chained as
      // `.eq('vendor', scopedVendor).or(\`managed_by.eq.${scopedVendor}\`)`, which
      // PostgREST/supabase-js ANDs together (vendor=X AND managed_by=X) -- almost
      // certainly not the intent. Fixed to match IncompletePage's identical
      // scoping: a single .or() so a proctor managed by OR vendor-tagged as this
      // vendor is included.
      if (scopedVendor) {
        query = query.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
      }

      // `vendor` here means the display vendor (managed_by || vendor), so the
      // filter dropdown needs to check both underlying columns too.
      if (filters.vendor) {
        query = query.or(`managed_by.eq.${filters.vendor},vendor.eq.${filters.vendor}`);
      }

      return query;
    },
    searchColumns: ['name', 'pid', 'phone'],
    searchTerm: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'oat', ascending: false },
  });

  const offboardedProctors = useMemo(
    () => (pageResult?.data ?? []).map(p => ({ ...p, vendor: p.managed_by || p.vendor || '' })),
    [pageResult]
  );
  const offboardedCount = pageResult?.count ?? 0;

  // Fetch archived proctors for history (admin only)
  const { data: archivedProctors = [], isLoading: isLoadingHistory } = useQuery({
    queryKey: ['archived-proctors'],
    queryFn: async () => {
      if (!isAdmin) return [];

      const { data, error } = await supabase
        .from('proctors')
        .select('*')
        .eq('status', 'Archived')
        .order('at', { ascending: true });

      if (error) throw error;

      return (data as Proctor[]).map(p => ({
        ...p,
        vendor: p.managed_by || p.vendor || ''
      }));
    },
    enabled: isAdmin,
  });

  // Re-onboard mutation
  const reOnboardMutation = useMutation({
    mutationFn: async (proctorId: string) => {
      const { error } = await supabase.rpc('re_onboard_proctor', { p_old_proctor_id: proctorId });
      if (error) throw error;
    },
    onSuccess: () => {
      showAlert('Proctor re-onboarded successfully! They will start fresh in In Progress.', { tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['offboarded-proctors'] });
      queryClient.invalidateQueries({ queryKey: ['archived-proctors'] });
    },
    onError: (error: any) => {
      showAlert('Failed to re-onboard: ' + error.message, { tone: 'error' });
    },
  });

  // Build history groups
  const historyGroups = useMemo(() => {
    if (!isAdmin) return [];

    // Find all aadhaar numbers with at least one Archived record
    const archivedAadhaar = new Set(
      archivedProctors.filter(p => p.status === 'Archived').map(p => p.aadhaar)
    );

    // Group all proctors by aadhaar (only those with history)
    const groups: Record<string, Proctor[]> = {};
    archivedProctors
      .filter(p => archivedAadhaar.has(p.aadhaar))
      .forEach(p => {
        if (!groups[p.aadhaar]) groups[p.aadhaar] = [];
        groups[p.aadhaar].push(p);
      });

    // Sort each group by onboard date
    Object.values(groups).forEach(g => g.sort((a, b) =>
      new Date(a.at).getTime() - new Date(b.at).getTime()
    ));

    // Filter by search
    return Object.keys(groups).filter(aad => {
      const g = groups[aad];
      const name = (g[0].name || '').toLowerCase();
      const vendorMatch = !historyVendorFilter || g.some(p => p.vendor === historyVendorFilter);
      const searchMatch = !historySearch ||
        name.includes(historySearch.toLowerCase()) ||
        g.some(p => (p.pid || '').toLowerCase().includes(historySearch.toLowerCase()));
      return vendorMatch && searchMatch;
    }).map(aad => groups[aad]);
  }, [archivedProctors, historySearch, historyVendorFilter, isAdmin]);

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
      'Archived': 'bg-text3/10 text-text3',
      'Offboarded': 'bg-danger/10 text-danger',
    };
    return (
      <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${colors[status] || 'bg-text3/10 text-text3'}`}>
        {status}
      </span>
    );
  };

  // Tab 0's main query is now paginated (25/page), so exporting means fetching
  // every row matching the current filters fresh, not just what's on screen --
  // same shape as ProctorsPage's handleExport -> proctorService.getAll(filters).
  // There's no dedicated proctorService entry for the Offboarded list, so this
  // mirrors the exact same filter/scoping logic as the paginated query above,
  // minus the .range().
  const exportOffboarded = async (): Promise<Proctor[]> => {
    let query = supabase.from('proctors').select('*').eq('status', 'Offboarded').order('oat', { ascending: false });

    if (scopedVendor) {
      query = query.or(`vendor.eq.${scopedVendor},managed_by.eq.${scopedVendor}`);
    }
    if (filters.vendor) {
      query = query.or(`managed_by.eq.${filters.vendor},vendor.eq.${filters.vendor}`);
    }
    const trimmedSearch = debouncedSearch.trim();
    if (trimmedSearch) {
      query = query.or(['name', 'pid', 'phone'].map((c) => `${c}.ilike.%${trimmedSearch}%`).join(','));
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data as Proctor[]).map((p) => ({ ...p, vendor: p.managed_by || p.vendor || '' }));
  };

  const exportCsv = async (tab: 'offboarded' | 'history') => {
    let list: Proctor[];
    if (tab === 'offboarded') {
      try {
        list = await exportOffboarded();
      } catch (error: any) {
        showAlert('Export failed: ' + error.message, { tone: 'error' });
        return;
      }
    } else {
      list = archivedProctors.filter((p) => p.status === 'Archived');
    }

    if (list.length === 0) {
      showAlert('No records to export', { tone: 'error' });
      return;
    }

    downloadCsv(
      `proctors_${tab}_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Proctor ID', 'Name', 'Vendor', 'Type', 'Phone', 'Email', 'City', 'State', 'Status', 'BGV', 'NDA', 'Created', 'Activated', 'Offboarded'],
      list.map((p) => [
        p.pid || '',
        p.name || '',
        p.vendor || p.managed_by || '',
        p.ptype || '',
        p.phone || '',
        p.email || '',
        p.city || '',
        p.state || '',
        p.status || '',
        p.bgv ? 'Yes' : 'No',
        p.nda ? 'Yes' : 'No',
        formatDate(p.at),
        formatDate(p.aat || ''),
        formatDate(p.oat || ''),
      ])
    );
  };

  return (
    <div>
      {/* Tabs */}
      <div className="mb-6">
        <UnderlineTabs
          options={[
            { label: 'Offboarded', value: 0, icon: UserMinus },
            ...(isAdmin ? [{ label: 'Re-onboard History', value: 1, icon: History }] : []),
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* Tab 0: Offboarded */}
      {activeTab === 0 && (
        <div>
          {/* Filters */}
          <div className="flex gap-2 mb-4 flex-wrap items-center">
            <Input
              placeholder="Name, ID, phone..."
              value={filters.search}
              onChange={(e) => {
                setFilters({ ...filters, search: e.target.value });
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
                value={filters.vendor}
                onChange={(e) => {
                  setFilters({ ...filters, vendor: e.target.value as any });
                  setPage(1);
                }}
                wrapperClassName="min-w-[160px]"
              />
            )}
            <ClearFiltersButton
              show={!!(filters.search || filters.vendor)}
              onClick={() => {
                setFilters({ search: '', vendor: '' });
                setPage(1);
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => exportCsv('offboarded')}>
<Download className="w-3.5 h-3.5" /> Export
            </Button>
          </div>

          {/* Table */}
          <Table
            data={offboardedProctors}
            isLoading={isLoadingOffboarded}
            emptyMessage="No offboarded proctors"
            pagination={{ page, pageSize: PAGE_SIZE, count: offboardedCount, isFetching: isFetchingOffboarded, onPageChange: setPage }}
            columns={[
              { header: 'ID', accessor: (proctor) => proctor.pid || '—', className: 'font-mono text-[12px] text-info' },
              { header: 'Name', accessor: (proctor) => proctor.name, className: 'text-[13px] text-text font-semibold' },
              { header: 'Vendor', accessor: (proctor) => proctor.vendor, className: 'text-[12px] text-text2' },
              { header: 'Offboarded', accessor: (proctor) => formatDate(proctor.oat!), className: 'text-[12px] text-text3' },
              { header: 'Reason', accessor: (proctor) => proctor.off_reason || '—', className: 'text-[12px] text-text2' },
              {
                header: 'Actions',
                accessor: (proctor) => (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm">
                      <Eye className="w-3.5 h-3.5" /> View
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={async () => {
                          const ok = await showConfirm(
                            `Re-onboard ${proctor.name}? They will start fresh in In Progress.`,
                            { title: 'Re-onboard proctor', confirmLabel: 'Re-onboard' }
                          );
                          if (ok) reOnboardMutation.mutate(proctor.id);
                        }}
                        disabled={reOnboardMutation.isPending}
                      >
                        <Undo2 className="w-3.5 h-3.5" /> Re-onboard
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* Tab 1: Re-onboard History */}
      {activeTab === 1 && isAdmin && (
        <div>
          {/* Filters */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <Input
              placeholder="Search name, PID..."
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              wrapperClassName="flex-1 min-w-[180px]"
            />
                <Select
                  options={[
                    { value: '', label: 'All Vendors' },
                    ...managedByOptions,
                  ]}
                  value={historyVendorFilter}
                  onChange={(e) => setHistoryVendorFilter(e.target.value)}
                  wrapperClassName="min-w-[160px]"
            />
            <ClearFiltersButton
              show={!!(historySearch || historyVendorFilter)}
              onClick={() => {
                setHistorySearch('');
                setHistoryVendorFilter('');
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => exportCsv('history')}>
<Download className="w-3.5 h-3.5" /> Export
            </Button>
          </div>

          {/* History Timeline */}
          <Table
            data={historyGroups}
            isLoading={isLoadingHistory}
            emptyMessage="No re-onboard history. Proctors who have been offboarded and re-onboarded will appear here."
            columns={[
              {
                header: 'Proctor',
                className: 'align-top whitespace-nowrap',
                accessor: (group) => (
                  <div>
                    <div className="text-sm font-semibold text-text">{group[0].name}</div>
                    <div className="text-[11px] text-text3">
                      {group.length} onboarding cycle{group.length > 1 ? 's' : ''}
                    </div>
                  </div>
                ),
              },
              {
                header: 'Onboarding Timeline',
                accessor: (group) => (
                  <div className="flex items-center gap-3 overflow-x-auto py-1">
                    {group.map((proctor, cycleIdx) => (
                      <div key={proctor.id} className="flex items-center gap-3">
                        <div className="flex-shrink-0 bg-surface2 border border-border rounded-lg p-3 min-w-[200px]">
                          <div className="text-[10px] font-bold text-accent uppercase tracking-wide mb-1">
                            Cycle {cycleIdx + 1}
                          </div>
                          <div className="font-mono text-[11px] text-info mb-2">
                            {proctor.pid || 'No PID'}
                          </div>
                          <div className="text-[11px] font-semibold text-text2 mb-2">{proctor.vendor}</div>
                          <div className="space-y-1">
                            <div className="flex items-center gap-1 text-[11px] text-text3">
                              <ArrowUp className="w-3 h-3" /> Onboarded: {formatDate(proctor.at)}
                            </div>
                            {(proctor.status === 'Archived' || proctor.status === 'Offboarded') ? (
                              <div className="flex items-center gap-1 text-[11px] text-text3">
                                <ArrowDown className="w-3 h-3" /> Offboarded: {formatDate(proctor.oat!)}
                                {proctor.off_reason && <div className="text-[10px]">({proctor.off_reason})</div>}
                              </div>
                            ) : (
                              <div className="text-[11px]">
                                {getStatusBadge(proctor.status)}
                              </div>
                            )}
                          </div>
                        </div>
                        {cycleIdx < group.length - 1 && (
                          <ArrowRight className="flex-shrink-0 w-5 h-5 text-text3" />
                        )}
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                header: 'Actions',
                className: 'align-top text-right whitespace-nowrap',
                accessor: () => (
                  <Button variant="ghost" size="sm">
                    <Eye className="w-3.5 h-3.5" /> View Current
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
