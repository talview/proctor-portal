import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import CommandPalette from './CommandPalette';
import BulkActivityDrawer from '@/components/bulk/BulkActivityDrawer';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { listRecentBulkJobs } from '@/services/bulkDispatch';

export default function MainLayout() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const { bulkActivityOpen, bulkActivityJobId, closeBulkActivity, sidebarCollapsed } = useUIStore();

  // One global instance instead of one per page with a "Bulk Activity" entry point --
  // lets the notification bell (outside all of those pages' component trees) open it
  // too, and lets this warm the job-list cache once on load instead of every page
  // paying for a fresh edge-function round trip the first time it's opened.
  useEffect(() => {
    if (user?.role !== 'admin') return;
    queryClient.prefetchQuery({ queryKey: ['bulk-jobs-recent'], queryFn: () => listRecentBulkJobs(20) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role]);

  return (
    // h-screen + overflow-hidden here (not the old min-h-screen, which let the
    // whole document grow taller than the viewport and scroll) is what makes the
    // content wrapper below the actual scrolling surface -- min-h-0 on both it and
    // <main> is the standard flexbox fix for a flex child otherwise refusing to
    // shrink below its content's intrinsic height. Every page's visible scroll
    // behavior is unchanged; only which element owns the scrollbar moves from
    // html/body to this one div, which is also what lets a page like Workspace
    // opt into "the page itself doesn't scroll" via a plain h-full.
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <main
        className={`flex-1 min-w-0 min-h-0 overflow-x-hidden ${
          sidebarCollapsed ? 'ml-[72px]' : 'ml-64 max-md:ml-[72px]'
        } flex flex-col bg-bg transition-[margin] duration-150`}
      >
        <Topbar />
        <div className="flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto p-6 bg-bg">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
      <BulkActivityDrawer isOpen={bulkActivityOpen} onClose={closeBulkActivity} initialJobId={bulkActivityJobId} />
    </div>
  );
}
