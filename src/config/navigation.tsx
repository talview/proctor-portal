import type { ComponentType } from 'react';
import {
  LayoutDashboard,
  Briefcase,
  UserSearch,
  Users,
  UserMinus,
  UserPlus,
  FileWarning,
  Award,
  FileCheck2,
  Building2,
  Handshake,
  UserCog,
  FileText,
  ScrollText,
  CalendarCheck2,
} from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

export interface NavSection {
  /** Empty for the top, ungrouped block (Dashboard/Workspace) -- rendered with
   * no group label, matching the artifact's sidebar. */
  title: string;
  items: NavItem[];
}

/** Single source of truth for the nav hierarchy -- the sidebar renders every
 * item directly, grouped under these section labels (no separate page-switcher
 * tier: a flat, direct list, matching the Proctor OS artifact's sidebar). */
export function getNavSections(role?: string): NavSection[] {
  if (role === 'admin') {
    return [
      {
        title: '',
        items: [
          { label: 'Workspace', path: '/workspace', icon: Briefcase },
          { label: 'Dashboard', path: '/', icon: LayoutDashboard },
        ],
      },
      {
        title: 'Workforce',
        items: [
          { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
          { label: 'Onboard', path: '/add-proctor', icon: UserPlus },
          { label: 'Proctors', path: '/proctors', icon: Users },
          { label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning },
          { label: 'Offboarded', path: '/offboarded', icon: UserMinus },
        ],
      },
      {
        title: 'Operations',
        items: [
          { label: 'Scheduled Events', path: '/scheduled-events', icon: CalendarCheck2 },
          { label: 'Proctor Certification', path: '/evaluations', icon: Award },
          { label: 'Client SOP', path: '/certifications', icon: FileCheck2 },
          { label: 'Vendors', path: '/vendors', icon: Handshake },
          { label: 'Customers', path: '/customers', icon: Building2 },
        ],
      },
      {
        title: 'Admin',
        items: [
          { label: 'Users', path: '/users', icon: UserCog },
          { label: 'NDA Template', path: '/nda-template', icon: FileText },
          { label: 'Audit Log', path: '/audit', icon: ScrollText },
        ],
      },
    ];
  } else if (role === 'coordinator') {
    return [
      {
        title: '',
        items: [{ label: 'Workspace', path: '/workspace', icon: Briefcase }],
      },
      {
        title: 'Workforce',
        items: [
          { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
          { label: 'Onboard', path: '/add-proctor', icon: UserPlus },
          { label: 'Proctors', path: '/my-proctors', icon: Users },
          { label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning },
        ],
      },
      {
        title: 'Operations',
        items: [
          { label: 'Scheduled Events', path: '/scheduled-events', icon: CalendarCheck2 },
          { label: 'Client SOP', path: '/certifications', icon: FileCheck2 },
        ],
      },
    ];
  }
  return [
    {
      title: '',
      items: [{ label: 'Dashboard', path: '/', icon: LayoutDashboard }],
    },
    {
      title: 'Workforce',
      items: [
        { label: 'Interview Selects', path: '/interview-selects', icon: UserSearch },
        { label: 'Proctors', path: '/my-proctors', icon: Users },
        { label: 'Incomplete BGV', path: '/incomplete', icon: FileWarning },
      ],
    },
    {
      title: 'Operations',
      items: [{ label: 'Client SOP', path: '/certifications', icon: FileCheck2 }],
    },
  ];
}

/** Which nav item (if any) the current path is on -- drives both the sidebar's
 * active-row highlight and the topbar's page-title crumb. */
export function findActiveItem(sections: NavSection[], pathname: string): NavItem | undefined {
  for (const section of sections) {
    const item = section.items.find((i) => (i.path === '/' ? pathname === '/' : pathname.startsWith(i.path)));
    if (item) return item;
  }
  return undefined;
}
