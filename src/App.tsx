import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './stores/auth';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingSpinner from './components/ui/LoadingSpinner';
import GlobalDialogHost from './components/ui/GlobalDialog';
import AcceptInvitePage from './pages/AcceptInvitePage';

// Pages -- lazy-loaded so each page's code (and its dependencies, e.g. the
// NDA pages' pdfjs-dist/pdf-lib) ships in its own chunk instead of all being
// eagerly bundled into the one file every route has to load upfront.
const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProctorsPage = lazy(() => import('./pages/ProctorsPage'));
const InterviewSelectsPage = lazy(() => import('./pages/InterviewSelectsPage'));
const OffboardedPage = lazy(() => import('./pages/OffboardedPage'));
const AddProctorPage = lazy(() => import('./pages/AddProctorPage'));
const EvaluationsPage = lazy(() => import('./pages/EvaluationsPage'));
const CertificationsPage = lazy(() => import('./pages/CertificationsPage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const VendorsPage = lazy(() => import('./pages/VendorsPage'));
const AuditLogPage = lazy(() => import('./pages/AuditLogPage'));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const IncompletePage = lazy(() => import('./pages/IncompletePage'));
const OnboardingFormPage = lazy(() => import('./pages/OnboardingFormPage'));
const NdaSignPage = lazy(() => import('./pages/NdaSignPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const NdaTemplatePage = lazy(() => import('./pages/NdaTemplatePage'));

// Layout
import MainLayout from './components/layout/MainLayout';
import RoleGate from './components/layout/RoleGate';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore();

  if (!isInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  const initialize = useAuthStore((state) => state.initialize);

  // Supabase's invite/recovery redirect lands with the session tokens in the URL
  // fragment (#access_token=...&type=invite) -- and can land on any path if the exact
  // redirectTo isn't in the project's allow-list, falling back to the bare site root.
  // Checking the hash here, before the router or the normal auth bootstrap runs, means
  // the invite is caught regardless of which path it actually landed on.
  const [isAcceptInvite] = useState(
    () => window.location.hash.includes('access_token=') && window.location.hash.includes('type=invite')
  );

  useEffect(() => {
    if (!isAcceptInvite) void initialize();
  }, [initialize, isAcceptInvite]);

  if (isAcceptInvite) {
    return (
      <ErrorBoundary>
        <AcceptInvitePage />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
      <GlobalDialogHost />
      <BrowserRouter>
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center bg-bg">
              <LoadingSpinner size="lg" />
            </div>
          }
        >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          
          {/* Public routes - no authentication required */}
          <Route path="/onboarding-form" element={<OnboardingFormPage />} />
          <Route path="/nda-sign" element={<NdaSignPage />} />
          
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <MainLayout />
              </ProtectedRoute>
            }
          >
            {/* Route-level role metadata lives here, in one place -- see RoleGate for why.
                `allow` omitted = any authenticated role. Mirrors src/config/navigation.tsx's
                per-role nav so a route is never reachable by direct navigation beyond who
                actually has a sidebar link to it. */}
            <Route index element={<DashboardPage />} />
            <Route path="proctors" element={<RoleGate allow={['admin']}><ProctorsPage /></RoleGate>} />
            <Route path="interview-selects" element={<InterviewSelectsPage />} />
            <Route path="onboarding" element={<Navigate to="/proctors" replace />} />
            <Route path="active" element={<Navigate to="/proctors" replace />} />
            <Route path="offboarded" element={<RoleGate allow={['admin']}><OffboardedPage /></RoleGate>} />
            <Route path="add-proctor" element={<RoleGate allow={['admin', 'coordinator']}><AddProctorPage /></RoleGate>} />
            <Route path="evaluations" element={<RoleGate allow={['admin']}><EvaluationsPage /></RoleGate>} />
            <Route path="workspace" element={<RoleGate allow={['admin', 'coordinator']}><WorkspacePage /></RoleGate>} />
            <Route path="incomplete" element={<IncompletePage />} />
            <Route path="my-proctors" element={<RoleGate allow={['coordinator', 'vendor']}><ProctorsPage /></RoleGate>} />
            <Route path="certifications" element={<CertificationsPage />} />
            <Route path="customers" element={<RoleGate allow={['admin']}><CustomersPage /></RoleGate>} />
            <Route path="vendors" element={<RoleGate allow={['admin']}><VendorsPage /></RoleGate>} />
            <Route path="audit" element={<RoleGate allow={['admin']}><AuditLogPage /></RoleGate>} />
            <Route path="users" element={<RoleGate allow={['admin']}><UsersPage /></RoleGate>} />
            <Route path="nda-template" element={<RoleGate allow={['admin']}><NdaTemplatePage /></RoleGate>} />
            <Route path="*" element={
              <div className="flex items-center justify-center h-64">
                <div className="text-center">
                  <div className="text-5xl mb-3">404</div>
                  <h3 className="text-lg font-semibold text-text mb-1">Page not found</h3>
                  <p className="text-text3 text-sm">The page you are looking for does not exist.</p>
                </div>
              </div>
            } />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
