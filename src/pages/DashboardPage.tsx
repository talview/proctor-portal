import { useQuery } from '@tanstack/react-query';
import { proctorService } from '@/services/proctor';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/services/supabase';
import { getScopedVendor } from '@/utils/access';
import Table from '@/components/ui/Table';
import LoadingSpinner from '@/components/ui/LoadingSpinner';

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
        .select('id, name, managed_by, vendor, status, upd, interview_stage')
        .order('upd', { ascending: false })
        .limit(20); // Fetch more to filter

      const scopedVendor = getScopedVendor(user);
      if (scopedVendor) {
        query = query.or(`vendor.eq."${scopedVendor}",managed_by.eq."${scopedVendor}"`);
      }

      const { data, error } = await query;
      if (error) throw error;

      // Map vendor field and filter out interview_selected like HTML app
      const filtered = (data || [])
        .map(p => ({ ...p, vendor: p.vendor || p.managed_by }))
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

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      'In Progress': 'bg-warning/10 text-warning',
      'Verified': 'bg-info/10 text-info',
      'Active': 'bg-success/10 text-success',
      'Offboarded': 'bg-danger/10 text-danger',
    };
    return (
      <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${colors[status] || 'bg-surface2 text-text3'}`}>
        {status}
      </span>
    );
  };


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
          <Table
            data={Object.entries(stats?.byVendor || {}).map(([vendor, data]: [string, any]) => ({ vendor, ...data }))}
            columns={[
              { header: 'Vendor', accessor: (row) => row.vendor, className: 'text-[13px] font-semibold text-text' },
              { header: 'Total', accessor: (row) => row.total, className: 'text-right font-mono text-sm text-text', headerClassName: 'text-right' },
              { header: 'In Progress', accessor: (row) => row.inProgress, className: 'text-right font-mono text-sm text-warning', headerClassName: 'text-right' },
              { header: 'Active', accessor: (row) => row.active, className: 'text-right font-mono text-sm text-success', headerClassName: 'text-right' },
              { header: 'BGV Missing', accessor: (row) => row.bgvMissing, className: 'text-right font-mono text-sm text-warning', headerClassName: 'text-right' },
              { header: 'BGV Overdue', accessor: (row) => row.bgvOverdue, className: 'text-right font-mono text-sm text-danger', headerClassName: 'text-right' },
              { header: 'Demo Cert', accessor: (row) => row.demoCert, className: 'text-right font-mono text-sm text-[#7c3aed]', headerClassName: 'text-right' },
              { header: 'Assess Cert', accessor: (row) => row.assessCert, className: 'text-right font-mono text-sm text-accent', headerClassName: 'text-right' },
            ]}
          />
        </div>
      )}

      {/* Recent Activity */}
      <div>
        <h3 className="text-xs font-semibold text-text3 uppercase tracking-wide mb-3">
          Recent Activity
        </h3>
        <Table
          data={recentActivity}
          emptyMessage="No activity yet"
          columns={[
            { header: 'Name', accessor: (p: any) => p.name, className: 'text-[13px] font-semibold text-text' },
            { header: 'Vendor', accessor: (p: any) => p.vendor || p.managed_by || '—', className: 'text-[12px] text-text2 font-medium' },
            { header: 'Status', accessor: (p: any) => getStatusBadge(p.status) },
            { header: 'Updated', accessor: (p: any) => formatDate(p.upd), className: 'text-[12px] text-text3' },
          ]}
        />
      </div>
    </div>
  );
}

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
      <div className={`text-[28px] font-bold font-mono leading-none ${valueColor}`}>
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
