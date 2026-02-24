import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { MemoryExplorerPage } from './pages/MemoryExplorerPage';
import { Shell } from './components/layout/Shell';
import { AuthGuard } from './components/auth/AuthGuard';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route
          path="/onboarding"
          element={
            <AuthGuard requireOnboarded={false}>
              <OnboardingPage />
            </AuthGuard>
          }
        />
        <Route
          path="/"
          element={
            <AuthGuard requireOnboarded>
              <Shell />
            </AuthGuard>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="connectors" element={<ConnectorsPage />} />
          <Route path="memories" element={<MemoryExplorerPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
