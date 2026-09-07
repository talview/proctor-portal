import type { ComponentType } from 'react';
import {
  LayoutDashboard,
  Briefcase,
  UserSearch,
  Users,
  UserMinus,
  UserPlus,
  UserRoundArrowLeft,
  FileWarning,
  Award,
  FileCheck2,
  Building2,
  Handshake,
  UserCog,
  FileText,
  ScrollText,
  Home,
  ClipboardList,
  ShieldCheck,
  Settings,
} from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export interface NavSection {
  title: string;
  icon: ComponentType<{ className?: string }>;
  items: NavItem[];
}

/** Single source of truth for the nav hierarchy -- the sidebar renders only the
 * section (category) level; PageSwitcher renders the items of whichever section
 * the current route belongs to. Keeping one shared list means the two can never
 * drift out of sync with each other. */
export function getNavSections(role?: string): NavSection[] {
  if (role === 'admin') {
    return [
      {
        title: 'Overview',
        icon: Home,
        items: [
          { label: 'Dashboard', path: '/', icon: LayoutDashboard },
          { label: 'Workspace', path: '/workspace', icon: Briefcase },
        ],
      },
      {
        title: 'Workforce',
        icon: UserRoundArrowLeft,
        items: [
          { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
          { label: 'Proctors', path: '/proctors', icon: Users },
          { label: 'Offboarded', path: '/offboarded', icon: UserMinus },
        ],
      },
      {
        title: 'Onboarding',
        icon: ClipboardList,
        items: [
          { label: 'Onboard', path: '/add-proctor', icon: UserPlus },
          { label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning },
        ],
      },
      {
        title: 'Certification',
        icon: ShieldCheck,
        items: [
          { label: 'Proctor Certification', path: '/evaluations', icon: Award },
          { label: 'Client SOP', path: '/certifications', icon: FileCheck2 },
        ],
      },
      {
        title: 'System',
        icon: Settings,
        items: [
          { label: 'Customers', path: '/customers', icon: Building2 },
          { label: 'Vendors', path: '/vendors', icon: Handshake },
          { label: 'Users', path: '/users', icon: UserCog },
          { label: 'NDA Template', path: '/nda-template', icon: FileText },
          { label: 'Audit Log', path: '/audit', icon: ScrollText },
        ],
      },
    ];
  } else if (role === 'coordinator') {
    return [
      {
        title: 'My Workspace',
        icon: Home,
        items: [{ label: 'Workspace', path: '/workspace', icon: Briefcase }],
      },
      {
        title: 'Workforce',
        icon: UserRoundArrowLeft,
        items: [
          { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
          { label: 'Proctors', path: '/my-proctors', icon: Users },
        ],
      },
      {
        title: 'Onboarding',
        icon: ClipboardList,
        items: [
          { label: 'Onboard', path: '/add-proctor', icon: UserPlus },
          { label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning },
        ],
      },
      {
        title: 'Certification',
        icon: ShieldCheck,
        items: [{ label: 'Client SOP', path: '/certifications', icon: FileCheck2 }],
      },
    ];
  }
  return [
    {
      title: 'Overview',
      icon: Home,
      items: [{ label: 'Dashboard', path: '/', icon: LayoutDashboard }],
    },
    {
      title: 'My Proctors',
      icon: Users,
      items: [
        { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
        { label: 'Proctors', path: '/my-proctors', icon: Users },
      ],
    },
    {
      title: 'Onboarding',
      icon: ClipboardList,
      items: [{ label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning }],
    },
    {
      title: 'Certification',
      icon: ShieldCheck,
      items: [{ label: 'Client SOP', path: '/certifications', icon: FileCheck2 }],
    },
  ];
}

/** Which section (if any) the current path belongs to. */
export function findActiveSection(sections: NavSection[], pathname: string): NavSection | undefined {
  return sections.find((s) =>
    s.items.some((i) => (i.path === '/' ? pathname === '/' : pathname.startsWith(i.path)))
  );
}
