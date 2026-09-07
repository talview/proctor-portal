import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { getNavSections, findActiveSection } from '@/config/navigation';
import logoWhite from '@/assets/branding/talview-logo-white.png';
import markWhite from '@/assets/branding/talview-mark-white.png';

/** Category-only rail. Child pages live in PageSwitcher, not here -- clicking a
 * category navigates to its first page, and the active category is derived from
 * the current route so the two stay in sync regardless of how you got there. */
export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const location = useLocation();
  const navigate = useNavigate();

  const navSections = getNavSections(user?.role);
  const activeSection = findActiveSection(navSections, location.pathname);
  const collapsed = sidebarCollapsed;

  return (
    <aside
      className={`${collapsed ? 'w-[72px]' : 'w-52'} max-md:w-[72px] bg-gradient-to-b from-[#0f2747] to-[#132e57] border-r border-white/10 fixed top-0 left-0 h-screen flex flex-col z-50 text-white shadow-xl transition-all duration-200`}
    >
      {/* Logo -- its own row, always centered, so it never has to squeeze in
          alongside the collapse toggle at 72px wide. */}
      <div className="border-b border-white/10">
        <div className="py-4 flex items-center justify-center">
          <img src={logoWhite} alt="Talview" className={`h-9 w-auto max-md:hidden ${collapsed ? 'hidden' : ''}`} />
          <img src={markWhite} alt="Talview" className={`h-9 w-9 ${collapsed ? 'block' : 'hidden'} max-md:block`} />
        </div>
        <button
          onClick={toggleSidebar}
          className="w-full flex items-center justify-center py-2 text-white/50 hover:text-white hover:bg-white/10 transition-colors max-md:hidden"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Categories */}
      <nav aria-label="Main navigation" className="flex-1 p-2 overflow-y-auto overflow-x-hidden">
        {navSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection?.title === section.title;
          return (
            <button
              key={section.title}
              onClick={() => navigate(section.items[0].path)}
              title={section.title}
              aria-current={isActive ? 'page' : undefined}
              className={`group relative w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors mb-1 max-md:justify-center ${collapsed ? 'justify-center' : ''} ${
                isActive
                  ? 'bg-accent/25 text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:bg-accent before:rounded-full'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span className={`truncate max-md:hidden ${collapsed ? 'hidden' : ''}`}>{section.title}</span>

              {/* Tooltip -- only needed in icon-only mode, where the label itself is hidden. */}
              {collapsed && (
                <span className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[#0a1c33] border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 z-50">
                  {section.title}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User Info */}
      <div className="p-2 border-t border-white/10">
        <div className={`flex items-center gap-2 rounded-lg hover:bg-white/5 p-1.5 max-md:justify-center ${collapsed ? 'justify-center' : ''}`}>
          <div
            className="w-8 h-8 rounded-full bg-gradient-to-br from-accent to-accent5 flex items-center justify-center text-[13px] font-bold text-white flex-shrink-0"
            title={`${user?.name || 'User'} (${user?.role || 'user'})`}
          >
            {user?.name?.charAt(0) || 'U'}
          </div>
          <div className={`flex-1 min-w-0 max-md:hidden ${collapsed ? 'hidden' : ''}`}>
            <div className="text-xs font-semibold text-white truncate leading-tight">{user?.name || 'User'}</div>
            <div className="text-[10px] text-white/60 capitalize truncate">{user?.role || 'User'}</div>
          </div>
          <button
            onClick={logout}
            className={`flex-shrink-0 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors max-md:hidden ${collapsed ? 'hidden' : ''}`}
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
        {/* Icon-only mode still needs a reachable sign-out control -- exactly one of
            hidden/flex is ever present as a base class, never both, so there's no
            same-specificity conflict for the max-md override to resolve. */}
        <button
          onClick={logout}
          className={`${collapsed ? 'flex' : 'hidden'} max-md:flex w-full items-center justify-center mt-1 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors`}
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
