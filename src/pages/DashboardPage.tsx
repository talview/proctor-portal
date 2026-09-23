import { useQuery } from '@tanstack/react-query';
import { proctorService } from '@/services/proctor';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/services/supabase';
import { getScopedVendor } from '@/utils/access';
import { formatRelativeTime } from '@/utils/formatters';
import DataTable from '@/components/ui/DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import EmptyState from '@/components/ui/EmptyState';
import { Activity } from 'lucide-react';

export default function DashboardPage() {
  const { user } = useAuthStore();

  const { data: stats, isLoading } = useQuery({
    queryKey: ['dashboard-stats', user?.vendor],
    queryFn: () => proctorService.getStats(getScopedVendor(user)),
  });

  // Fetch recent activity (last 8 updated proctors, excluding interview_selected)
  const { data: recentActivity = [] } = useQuery({
    queryKey: ['recent-activity', user?.vendor],
    queryFn: async () => {
      let query = supabase
        .from('proctors')
        .select('id, name, vendor, status, upd, interview_stage')
        .order('upd', { ascending: false })
        .limit(20); // Fetch more to filter

      const scopedVendor = getScopedVendor(user);
      if (scopedVendor) {
        query = query.eq('vendor', scopedVendor);
      }

      const { data, error } = await query;
      if (error) throw error;

      // Filter out interview_selected like HTML app
      const filtered = (data || [])
        .filter(p => p.interview_stage !== 'interview_selected')
        .slice(0, 8);
      
      return filtered;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner size="md" />
          <p className="text-text2 text-sm">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  // get_proctor_stats already returns every stage's count directly (already
  // scoped to the current vendor for a coordinator/vendor view) -- no separate
  // query needed to drive this funnel.
  const funnelStages = [
    { label: 'In Progress', value: stats?.inProgress || 0, tone: 'info' },
    { label: 'Verified', value: stats?.verified || 0, tone: 'warning' },
    { label: 'Active', value: stats?.active || 0, tone: 'success' },
    { label: 'Offboarded', value: stats?.offboarded || 0, tone: 'neutral' },
  ];
  const funnelTotal = funnelStages.reduce((sum, s) => sum + s.value, 0) || 1;

  return (
    <div>
      {/* Statistics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-4 mb-6">
        <StatCard
          label="Total Proctors"
          value={stats?.total || 0}
          className="border-l-accent"
        />
        <StatCard
          label="In Progress"
          value={stats?.inProgress || 0}
          className="border-l-warning"
        />
        <StatCard
          label="Interview Selects"
          value={stats?.interviewSelects || 0}
          subtitle="Pre-onboarding"
          className="border-l-[#8b5cf6]"
        />
        <StatCard
          label="Active"
          value={stats?.active || 0}
          className="border-l-success"
        />
        <StatCard
          label="BGV Overdue"
          value={stats?.bgvOverdue || 0}
          subtitle={`of ${stats?.bgvMissing || 0} missing`}
          valueColor="text-danger"
          className="border-l-danger"
        />
        <StatCard
          label="Demo Certified"
          value={stats?.demoCert || 0}
          valueColor="text-[#a78bfa]"
          className="border-l-[#a78bfa]"
        />
        <StatCard
          label="Assessment Certified"
          value={stats?.assessCert || 0}
          valueColor="text-success"
          className="border-l-success"
        />
      </div>

      {/* Vendor Breakdown */}
      {user?.role === 'admin' && Object.keys(stats?.byVendor || {}).length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text3 uppercase tracking-wide mb-3 pb-2 border-b border-border">
            Vendor Breakdown
          </h3>
          <DataTable
            data={Object.entries(stats?.byVendor || {}).map(([vendor, data]: [string, any]) => ({ vendor, ...data }))}
            columns={[
              { id: 'vendor', header: 'Vendor', enableSorting: false, cell: ({ row }) => row.original.vendor, meta: { className: 'text-[13px] font-semibold text-text' } },
              { id: 'total', header: 'Total', enableSorting: false, cell: ({ row }) => row.original.total, meta: { className: 'text-right font-display tabular-nums text-sm text-text', headerClassName: 'text-right' } },
              { id: 'inProgress', header: 'In Progress', enableSorting: false, cell: ({ row }) => row.original.inProgress, meta: { className: 'text-right font-display tabular-nums text-sm text-warning', headerClassName: 'text-right' } },
              { id: 'active', header: 'Active', enableSorting: false, cell: ({ row }) => row.original.active, meta: { className: 'text-right font-display tabular-nums text-sm text-success', headerClassName: 'text-right' } },
              { id: 'bgvMissing', header: 'BGV Missing', enableSorting: false, cell: ({ row }) => row.original.bgvMissing, meta: { className: 'text-right font-display tabular-nums text-sm text-warning', headerClassName: 'text-right' } },
              { id: 'bgvOverdue', header: 'BGV Overdue', enableSorting: false, cell: ({ row }) => row.original.bgvOverdue, meta: { className: 'text-right font-display tabular-nums text-sm text-danger', headerClassName: 'text-right' } },
              { id: 'demoCert', header: 'Demo Cert', enableSorting: false, cell: ({ row }) => row.original.demoCert, meta: { className: 'text-right font-display tabular-nums text-sm text-[#7c3aed]', headerClassName: 'text-right' } },
              { id: 'assessCert', header: 'Assess Cert', enableSorting: false, cell: ({ row }) => row.original.assessCert, meta: { className: 'text-right font-display tabular-nums text-sm text-accent', headerClassName: 'text-right' } },
            ] satisfies ColumnDef<any, any>[]}
          />
        </div>
      )}

      {/* Workforce by stage (funnel) + Recent activity (feed) -- a pipeline
          breakdown paired with a compact live-ish feed, replacing the old plain
          "Recent Activity" table. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
        <div className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-text3 uppercase tracking-wide mb-4">
            Workforce by Stage
          </h3>
          <div className="space-y-3.5">
            {funnelStages.map((stage) => (
              <div key={stage.label} className="flex items-center gap-3">
                <div className="w-[92px] flex-shrink-0 text-[12px] font-semibold text-text2">{stage.label}</div>
                <div className="flex-1 h-2.5 bg-surface2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${STAGE_BAR_CLASS[stage.tone]}`}
                    style={{ width: `${Math.round((stage.value / funnelTotal) * 100)}%` }}
                  />
                </div>
                <div className="w-14 flex-shrink-0 text-right text-[12px] font-display font-bold tabular-nums text-text">{stage.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-text3 uppercase tracking-wide mb-4">
            Recent Activity
          </h3>
          {recentActivity.length === 0 ? (
            <EmptyState icon={Activity} title="No activity yet" compact />
          ) : (
            <div className="divide-y divide-border">
              {recentActivity.map((row: any) => (
                <div key={row.id} className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${STAGE_DOT_CLASS[STATUS_TONE[row.status] || 'neutral']}`} />
                  <div className="min-w-0">
                    <div className="text-[12px] text-text2 leading-relaxed">
                      <span className="font-semibold text-text">{row.name}</span> — {row.status}
                      {row.vendor ? ` · ${row.vendor}` : ''}
                    </div>
                    <div className="text-[10.5px] text-text3 mt-0.5">{formatRelativeTime(row.upd)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Matches the "Proctor OS" reference artifact's own tone mapping -- see Badge.tsx
// for the same mapping applied to the actual status pills.
const STATUS_TONE: Record<string, string> = {
  'In Progress': 'info',
  'Verified': 'warning',
  'Active': 'success',
  'Offboarded': 'neutral',
};
const STAGE_BAR_CLASS: Record<string, string> = {
  warning: 'bg-warning',
  info: 'bg-info',
  success: 'bg-success',
  danger: 'bg-danger',
  neutral: 'bg-text3',
};
const STAGE_DOT_CLASS: Record<string, string> = {
  warning: 'bg-warning',
  info: 'bg-info',
  success: 'bg-success',
  danger: 'bg-danger',
  neutral: 'bg-text3',
};

interface StatCardProps {
  label: string;
  value: number;
  subtitle?: string;
  valueColor?: string;
  className?: string;
}

function StatCard({ label, value, subtitle, valueColor = 'text-text', className = '' }: StatCardProps) {
  return (
    <div
      className={`bg-surface border border-border rounded-lg p-4 border-l-[3px] ${className}`}
    >
      <div className="text-[11px] font-semibold text-text3 uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className={`text-[23px] font-display font-bold tabular-nums leading-none ${valueColor}`}>
        {value}
      </div>
      {subtitle && (
        <div className="text-[11px] text-text3 mt-1">
          {subtitle}
        </div>
      )}
    </div>
  );
}
