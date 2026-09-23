import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, PanelLeftClose, PanelLeftOpen, KeyRound } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { getNavSections, findActiveItem } from '@/config/navigation';
import Avatar from '@/components/ui/Avatar';
import logoWhite from '@/assets/branding/talview-logo-white.png';
import markWhite from '@/assets/branding/talview-mark-white.png';

/** A flat, direct list -- every page is its own row, grouped only under plain
 * section labels (no icon, no click target of its own), matching the Proctor OS
 * artifact's sidebar. Replaces the old two-tier design (a category-only rail
 * plus a separate page-switcher pill bar in the topbar) the user asked to
 * revert away from.
 *
 * Two independent ways to end up icon-only: a manual desktop collapse
 * (`sidebarCollapsed`, persisted, toggled via the chevron button below) and
 * the automatic `max-md:` narrowing below the md breakpoint (a screen-size
 * fallback that always applies regardless of the manual state). Every
 * collapsed-only class below is written as `collapsed ? 'X' : 'max-md:X'` so
 * both triggers land on the same icon-only treatment without interfering
 * with each other. */
export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const { sidebarCollapsed: collapsed, toggleSidebarCollapsed } = useUIStore();

  const navSections = getNavSections(user?.role);
  const activeItem = findActiveItem(navSections, location.pathname);

  return (
    <aside
      // Light mode: constant dark chrome, deliberately NOT a theme token -- stays this
      // same violet-anchored navy regardless of app theme, so it reads as chrome rather
      // than competing with the light content area. Dark mode: falls back to the same
      // solid --color-bg the main content area uses (dark:bg-none clears the gradient
      // image so dark:bg-bg's solid color shows through), so the chrome matches the page
      // instead of standing out as a separate violet block next to a near-black page.
      className={`${collapsed ? 'w-[72px]' : 'w-64 max-md:w-[72px]'} bg-gradient-to-b from-[#15132A] to-[#211D45] dark:bg-none dark:bg-bg border-r border-white/10 fixed top-0 left-0 h-screen flex flex-col z-50 text-white shadow-xl transition-[width] duration-150`}
    >
      {/* Logo + collapse toggle */}
      <div className="border-b border-white/10">
        <div className={`py-4 flex items-center ${collapsed ? 'flex-col gap-2' : 'justify-between px-3 max-md:flex-col max-md:gap-2'}`}>
          <img src={logoWhite} alt="Talview" className={`h-9 w-auto ${collapsed ? 'hidden' : 'max-md:hidden'}`} />
          <img src={markWhite} alt="Talview" className={`h-9 w-9 ${collapsed ? 'block' : 'hidden max-md:block'}`} />
          <button
            onClick={toggleSidebarCollapsed}
            className={`flex-shrink-0 text-white/50 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors max-md:hidden`}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Flat page list */}
      <nav aria-label="Main navigation" className="flex-1 p-2 overflow-y-auto overflow-x-hidden">
        {navSections.map((section, sectionIdx) => (
          <div key={section.title || `section-${sectionIdx}`} className={sectionIdx > 0 ? 'mt-4' : ''}>
            {section.title && (
              <div
                className={`px-3 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/35 ${collapsed ? 'hidden' : 'max-md:hidden'}`}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeItem?.path === item.path;
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  title={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group relative w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-colors mb-0.5 ${
                    collapsed ? 'justify-center' : 'max-md:justify-center'
                  } ${
                    isActive
                      ? 'bg-accent/25 text-white before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:bg-accent before:rounded-full'
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className={`truncate flex-1 text-left ${collapsed ? 'hidden' : 'max-md:hidden'}`}>{item.label}</span>

                  {/* Tooltip -- only needed when the label itself is hidden (either collapse trigger). */}
                  <span
                    className={`pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[#1A1730] border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 z-50 ${
                      collapsed ? 'block' : 'hidden max-md:block'
                    }`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User Info */}
      <div className="p-2 border-t border-white/10">
        <div className={`flex items-center gap-2 rounded-lg hover:bg-white/5 p-1.5 ${collapsed ? 'justify-center' : 'max-md:justify-center'}`}>
          <Avatar name={user?.name} title={`${user?.name || 'User'} (${user?.role || 'user'})`} />
          <div className={`flex-1 min-w-0 ${collapsed ? 'hidden' : 'max-md:hidden'}`}>
            <div className="text-xs font-semibold text-white truncate leading-tight">{user?.name || 'User'}</div>
            <div className="text-[10px] text-white/60 capitalize truncate">{user?.role || 'User'}</div>
          </div>
          <button
            onClick={() => navigate('/change-password')}
            className={`flex-shrink-0 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors ${
              collapsed ? 'hidden' : 'max-md:hidden'
            }`}
            title="Change Password"
          >
            <KeyRound className="w-4 h-4" />
          </button>
          <button
            onClick={logout}
            className={`flex-shrink-0 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors ${
              collapsed ? 'hidden' : 'max-md:hidden'
            }`}
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
        {/* Icon-only mode (either collapse trigger) still needs reachable sign-out/
            change-password controls. */}
        <button
          onClick={() => navigate('/change-password')}
          className={`${
            collapsed ? 'flex' : 'hidden max-md:flex'
          } w-full items-center justify-center mt-1 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors`}
          title="Change Password"
        >
          <KeyRound className="w-4 h-4" />
        </button>
        <button
          onClick={logout}
          className={`${
            collapsed ? 'flex' : 'hidden max-md:flex'
          } w-full items-center justify-center mt-1 text-white/60 hover:text-white hover:bg-white/10 rounded-md p-1.5 transition-colors`}
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
