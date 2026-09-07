import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import { useUIStore } from '@/stores/ui';

export default function MainLayout() {
  const { sidebarCollapsed } = useUIStore();

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <main className={`flex-1 min-w-0 overflow-x-hidden ${sidebarCollapsed ? 'ml-[72px]' : 'ml-52'} max-md:ml-[72px] flex flex-col bg-bg transition-all duration-200`}>
        <Topbar />
        <div className="flex-1 min-w-0 overflow-x-hidden p-6 bg-bg">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
