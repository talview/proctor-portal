import { Lock } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import type { UserRole } from '@/types';

/**
 * Single, centralized route-level access check -- before this, "who can open this
 * page" was decided five different, inconsistent ways depending which page you
 * looked at: sidebar visibility (cosmetic only, never actually blocked direct
 * navigation), a hand-copied "Access Only" block pasted into some page components
 * but not others (CustomersPage/VendorsPage/UsersPage/NdaTemplatePage had one,
 * AuditLogPage/EvaluationsPage/WorkspacePage had none at all), RLS policies (govern
 * data, not page access), and edge-function/RPC role checks (govern actions, not
 * navigation). A security review confirmed the gap concretely: a coordinator or
 * vendor could navigate straight to /audit or /evaluations and the page rendered in
 * full, even though neither route was ever in their sidebar.
 *
 * This wraps a route's element in App.tsx with the roles allowed to open it --
 * app-wide, in one file, instead of duplicated per-page. `allow` omitted means any
 * authenticated role (ProtectedRoute already handles "must be logged in at all").
 */
export default function RoleGate({ allow, children }: { allow?: UserRole[]; children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore();

  // Currently masked by ProtectedRoute (App.tsx) already blocking until auth
  // resolves one level up, but checked directly here too rather than relying
  // on that ordering -- a role check run before `user` has loaded would
  // otherwise render "Access Restricted" for a fraction of a second even for
  // someone who's actually allowed in.
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (allow && (!user?.role || !allow.includes(user.role))) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Lock className="w-10 h-10 text-text3 mx-auto mb-2" />
          <h3 className="text-lg font-semibold text-text mb-1">Access Restricted</h3>
          <p className="text-text3 text-sm">You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
