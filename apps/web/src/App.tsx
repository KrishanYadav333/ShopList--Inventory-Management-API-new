import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Home, Invite, Login } from './pages/AuthPages';
import { HistoryPage } from './pages/HistoryPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';

// Clerk's widget is only needed on the client sign-in page, so it is loaded on demand.
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const PurchasingPage = lazy(() => import('./pages/PurchasingPage').then((m) => ({ default: m.PurchasingPage })));
const CountsPage = lazy(() => import('./pages/CountsPage').then((m) => ({ default: m.CountsPage })));
const CustomersPage = lazy(() => import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const InvoicePage = lazy(() => import('./pages/InvoicePage'));
const SharePage = lazy(() => import('./pages/SharePage'));
const ClerkSignIn = lazy(() => import('./pages/ClerkSignIn'));
// The platform console is only for the owner, so it loads on demand too.
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/owner" element={<Login owner />} />
      <Route path="/sign-in/*" element={<Suspense fallback={<div className="boot">Loading…</div>}><ClerkSignIn /></Suspense>} />
      <Route path="/sign-up/*" element={<Suspense fallback={<div className="boot">Loading…</div>}><ClerkSignIn /></Suspense>} />
      <Route path="/o/:orgId/orders/:orderId/print" element={<Suspense fallback={<div className="boot">Loading…</div>}><InvoicePage /></Suspense>} />
      <Route path="/s/:kind/:token" element={<Suspense fallback={<div className="boot">Loading…</div>}><SharePage /></Suspense>} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/admin/:page?" element={<Suspense fallback={<div className="boot">Loading…</div>}><AdminPage /></Suspense>} />
      <Route path="/" element={<Home />} />
      <Route path="/o/:orgId" element={<Shell />}>
        <Route index element={<Navigate to="orders" replace />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="customers" element={<Suspense fallback={<div className="boot">Loading…</div>}><CustomersPage /></Suspense>} />
        <Route path="counts" element={<Suspense fallback={<div className="boot">Loading…</div>}><CountsPage /></Suspense>} />
        <Route path="purchasing" element={<Suspense fallback={<div className="boot">Loading…</div>}><PurchasingPage /></Suspense>} />
        <Route path="reports" element={<Suspense fallback={<div className="boot">Loading…</div>}><ReportsPage /></Suspense>} />
        <Route path="approvals" element={<Suspense fallback={<div className="boot">Loading…</div>}><ApprovalsPage /></Suspense>} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
