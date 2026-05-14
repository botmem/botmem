import { lazy, Suspense, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { LoadingScreen } from './components/ui/LoadingScreen';
import { posthog } from './lib/posthog';
import { appUrl } from './lib/urls';

const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((m) => ({ default: m.LandingPage })),
);
const PricingPage = lazy(() =>
  import('./pages/PricingPage').then((m) => ({ default: m.PricingPage })),
);
const PrivacyPage = lazy(() =>
  import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() => import('./pages/TermsPage').then((m) => ({ default: m.TermsPage })));
const DataPolicyPage = lazy(() =>
  import('./pages/DataPolicyPage').then((m) => ({ default: m.DataPolicyPage })),
);

function PageviewTracker() {
  const location = useLocation();
  useEffect(() => {
    posthog.capture('$pageview');
  }, [location.pathname]);
  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function AppRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(appUrl(to));
  }, [to]);
  return <LoadingScreen />;
}

function RoutesOnly(): ReactNode {
  return (
    <>
      <ScrollToTop />
      <PageviewTracker />
      <ErrorBoundary>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route index element={<LandingPage />} />
            <Route path="/landing" element={<Navigate to="/" replace />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/data-policy" element={<DataPolicyPage />} />
            <Route path="/login" element={<AppRedirect to="/login" />} />
            <Route path="/signup" element={<AppRedirect to="/signup" />} />
            <Route path="/forgot-password" element={<AppRedirect to="/forgot-password" />} />
            <Route path="/reset-password" element={<AppRedirect to="/reset-password" />} />
            <Route path="/cli-login" element={<AppRedirect to="/cli-login" />} />
            <Route path="/oauth/consent" element={<AppRedirect to="/oauth/consent" />} />
            <Route path="/dashboard" element={<AppRedirect to="/dashboard" />} />
            <Route path="/me" element={<AppRedirect to="/me" />} />
            <Route path="/connectors" element={<AppRedirect to="/connectors" />} />
            <Route path="/people" element={<AppRedirect to="/people" />} />
            <Route path="/contacts" element={<AppRedirect to="/people" />} />
            <Route path="/settings" element={<AppRedirect to="/settings" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

export function LandingApp() {
  return (
    <BrowserRouter>
      <RoutesOnly />
    </BrowserRouter>
  );
}
