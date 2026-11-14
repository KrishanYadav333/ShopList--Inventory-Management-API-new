import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Home, Invite, Login } from './pages/AuthPages';
import { AdminPage } from './pages/AdminPage';
import { HistoryPage } from './pages/HistoryPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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
