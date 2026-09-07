import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { getNavSections, findActiveSection } from '@/config/navigation';
import SegmentedTabs from '@/components/ui/SegmentedTabs';

/** Replaces the old plain-text page title with pill/segmented-control navigation
 * between the pages of the current sidebar category -- deliberately the opposite
 * style from in-page tabs (UnderlineTabs), so the two navigation tiers never look
 * like the same control. */
export default function PageSwitcher() {
  const { user } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();

  const navSections = getNavSections(user?.role);
  const activeSection = findActiveSection(navSections, location.pathname);
  if (!activeSection) return null;

  const activeItem = activeSection.items.find((i) =>
    i.path === '/' ? location.pathname === '/' : location.pathname.startsWith(i.path)
  );

  return (
    <>
      {/* The segmented control below already shows the page name visually --
          this just gives screen readers a page-level heading/landmark after
          navigation, which nothing else in the layout provides. */}
      <h1 className="sr-only">{activeItem?.label ?? activeSection.items[0].label}</h1>
      <SegmentedTabs
        options={activeSection.items.map((item) => ({ label: item.label, value: item.path, icon: item.icon }))}
        value={activeItem?.path ?? activeSection.items[0].path}
        onChange={(path) => navigate(path)}
      />
    </>
  );
}
