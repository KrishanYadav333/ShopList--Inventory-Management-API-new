import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Home, Invite, Login } from './pages/AuthPages';
import { AdminPage } from './pages/AdminPage';
import { HistoryPage } from './pages/HistoryPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';

// Clerk's widget is only needed on the client sign-in page, so it is loaded on demand.
const ClerkSignIn = lazy(() => import('./pages/ClerkSignIn'));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/sign-in/*" element={<Suspense fallback={<div className="boot">Loading…</div>}><ClerkSignIn /></Suspense>} />
      <Route path="/sign-up/*" element={<Suspense fallback={<div className="boot">Loading…</div>}><ClerkSignIn /></Suspense>} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/" element={<Home />} />
      <Route path="/o/:orgId" element={<Shell />}>
        <Route index element={<Navigate to="orders" replace />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
