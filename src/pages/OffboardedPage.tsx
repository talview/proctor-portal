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
import { useVendorOptions } from '@/hooks/useVendorOptions';
import { useCursorPaginatedQuery } from '@/hooks/useCursorPaginatedQuery';
import { showAlert, showConfirm } from '@/components/ui/GlobalDialog';
import { downloadCsv, EXPORT_ROW_CAP } from '@/lib/csv';
import { localDateString } from '@/utils/formatters';
import { orIlikeFilter } from '@/utils/postgrest';
import ClearFiltersButton from '@/components/ui/ClearFiltersButton';
import DataTable from '@/components/ui/DataTable';
import Badge from '@/components/ui/Badge';
import { ProctorDrawer } from './ProctorsPage';
import type { ColumnDef } from '@tanstack/react-table';
import type { Proctor, OffboardedFilters } from '@/types';

export default function OffboardedPage() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState(0);
  // Read-only reuse of Proctors' own drawer -- isAdmin/isVendor false throughout
  // means no edit pencil, no document replace/remove: correcting an offboarded
  // record means re-onboarding it first (the action already on this page), not
  // editing it in place from here.
  const [viewingProctor, setViewingProctor] = useState<Proctor | null>(null);
  const [filters, setFilters] = useState<OffboardedFilters>({ search: '', vendor: '' });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyVendorFilter, setHistoryVendorFilter] = useState('');
  const PAGE_SIZE = 25;
  const { data: vendorOptions = [] } = useVendorOptions();

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
  const {
    data: offboardedProctors,
    isLoading: isLoadingOffboarded,
    isFetching: isFetchingOffboarded,
    hasNextPage: offboardedHasNextPage,
    hasPreviousPage: offboardedHasPreviousPage,
    goToNextPage: offboardedGoToNextPage,
    goToPreviousPage: offboardedGoToPreviousPage,
    pageIndex: offboardedPageIndex,
  } = useCursorPaginatedQuery<Proctor>({
    queryKey: ['offboarded-proctors', user?.vendor, filters.vendor],
    table: 'proctors',
    filters: (q) => {
      let query = q.eq('status', 'Offboarded');

      // Vendor role sees only their proctors.
      if (scopedVendor) {
        query = query.eq('vendor', scopedVendor);
      }

      if (filters.vendor) {
        query = query.eq('vendor', filters.vendor);
      }

      return query;
    },
    searchColumns: ['name', 'pid'],
    searchTerm: debouncedSearch,
    pageSize: PAGE_SIZE,
    orderBy: { column: 'oat', ascending: false },
    resetKey: filters.vendor,
    // Narrowed from select('*') -- verified against this tab's table columns; the
    // "View" button has no onClick (no modal reads this row), and both CSV exports
    // (exportOffboarded, archivedProctors) run their own separate full-select queries.
    select: 'id, pid, name, vendor, oat, off_reason',
  });

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

      return data as Proctor[];
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

  // Tab 0's main query is now paginated (25/page), so exporting means fetching
  // every row matching the current filters fresh, not just what's on screen --
  // same shape as ProctorsPage's handleExport -> proctorService.getAll(filters).
  // There's no dedicated proctorService entry for the Offboarded list, so this
  // mirrors the exact same filter/scoping logic as the paginated query above,
  // bounded by EXPORT_ROW_CAP instead of the on-screen page's .range().
  const exportOffboarded = async (): Promise<{ rows: Proctor[]; truncated: boolean }> => {
    let query = supabase.from('proctors').select('*').eq('status', 'Offboarded').order('oat', { ascending: false });

    if (scopedVendor) {
      query = query.eq('vendor', scopedVendor);
    }
    if (filters.vendor) {
      query = query.eq('vendor', filters.vendor);
    }
    const trimmedSearch = debouncedSearch.trim();
    if (trimmedSearch) {
      query = query.or(orIlikeFilter(['name', 'pid', 'phone'], trimmedSearch));
    }

    const { data, error } = await query.range(0, EXPORT_ROW_CAP);
    if (error) throw error;
    const rows = (data ?? []) as Proctor[];
    return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP };
  };

  const exportCsv = async (tab: 'offboarded' | 'history') => {
    let list: Proctor[];
    let truncated = false;
    if (tab === 'offboarded') {
      try {
        ({ rows: list, truncated } = await exportOffboarded());
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
      `proctors_${tab}_${localDateString()}.csv`,
      ['Proctor ID', 'Name', 'Vendor', 'Type', 'Phone', 'Email', 'City', 'State', 'Status', 'BGV', 'NDA', 'Created', 'Activated', 'Offboarded'],
      list.map((p) => [
        p.pid || '',
        p.name || '',
        p.vendor || '',
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
    if (truncated) {
      showAlert(
        `Export capped at ${EXPORT_ROW_CAP.toLocaleString()} rows -- narrow your filters to get a complete export.`,
        { tone: 'error' }
      );
    }
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
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              wrapperClassName="flex-1 min-w-[180px]"
            />
            {!isVendor && (
              <Select
                options={[
                  { value: '', label: 'All Vendors' },
                  ...vendorOptions,
                ]}
                value={filters.vendor}
                onChange={(e) => setFilters({ ...filters, vendor: e.target.value as any })}
                wrapperClassName="min-w-[160px]"
              />
            )}
            <ClearFiltersButton
              show={!!(filters.search || filters.vendor)}
              onClick={() => setFilters({ search: '', vendor: '' })}
            />
            <Button variant="ghost" size="sm" onClick={() => exportCsv('offboarded')}>
<Download className="w-3.5 h-3.5" /> Export
            </Button>
          </div>

          {/* Table */}
          <DataTable
            data={offboardedProctors}
            isLoading={isLoadingOffboarded}
            onRowClick={setViewingProctor}
            emptyMessage="No offboarded proctors"
            pagination={{
              pageIndex: offboardedPageIndex,
              pageSize: PAGE_SIZE,
              hasNextPage: offboardedHasNextPage,
              hasPreviousPage: offboardedHasPreviousPage,
              isFetching: isFetchingOffboarded,
              onNext: offboardedGoToNextPage,
              onPrevious: offboardedGoToPreviousPage,
            }}
            columns={[
              { id: 'pid', header: 'ID', enableSorting: false, cell: ({ row }) => row.original.pid || '—', meta: { className: 'font-mono text-[12px] text-info' } },
              { id: 'name', header: 'Name', enableSorting: false, cell: ({ row }) => row.original.name, meta: { className: 'text-[13px] text-text font-semibold' } },
              { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-[12px] text-text2' } },
              { id: 'oat', header: 'Offboarded', enableSorting: false, cell: ({ row }) => formatDate(row.original.oat!), meta: { className: 'text-[12px] text-text3' } },
              { id: 'off_reason', header: 'Reason', enableSorting: false, cell: ({ row }) => row.original.off_reason || '—', meta: { className: 'text-[12px] text-text2' } },
              {
                id: 'actions',
                header: 'Actions',
                enableSorting: false,
                cell: ({ row }) => {
                  const proctor = row.original;
                  return (
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" onClick={() => setViewingProctor(proctor)}>
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
                  );
                },
              },
            ] satisfies ColumnDef<Proctor, any>[]}
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
                    ...vendorOptions,
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
          <DataTable
            data={historyGroups}
            isLoading={isLoadingHistory}
            emptyMessage="No re-onboard history. Proctors who have been offboarded and re-onboarded will appear here."
            columns={[
              {
                id: 'proctor',
                header: 'Proctor',
                enableSorting: false,
                meta: { className: 'align-top whitespace-nowrap' },
                cell: ({ row }) => {
                  const group = row.original;
                  return (
                    <div>
                      <div className="text-sm font-semibold text-text">{group[0].name}</div>
                      <div className="text-[11px] text-text3">
                        {group.length} onboarding cycle{group.length > 1 ? 's' : ''}
                      </div>
                    </div>
                  );
                },
              },
              {
                id: 'timeline',
                header: 'Onboarding Timeline',
                enableSorting: false,
                cell: ({ row }) => {
                  const group = row.original;
                  return (
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
                                <Badge status={proctor.status} />
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
                  );
                },
              },
              {
                id: 'actions',
                header: 'Actions',
                enableSorting: false,
                meta: { className: 'align-top text-right whitespace-nowrap' },
                cell: ({ row }) => (
                  <Button variant="ghost" size="sm" onClick={() => setViewingProctor(row.original[row.original.length - 1])}>
                    <Eye className="w-3.5 h-3.5" /> View Current
                  </Button>
                ),
              },
            ] satisfies ColumnDef<Proctor[], any>[]}
          />
        </div>
      )}

      {viewingProctor && (
        <ProctorDrawer
          proctor={viewingProctor}
          mode="view"
          isAdmin={false}
          isVendor={false}
          onClose={() => setViewingProctor(null)}
          onEdit={() => {}}
          onCancelEdit={() => {}}
          onSave={() => {}}
          isSaving={false}
        />
      )}
    </div>
  );
}
