import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Home, Invite, Login } from './pages/AuthPages';
import { HistoryPage } from './pages/HistoryPage';
import { ProductsPage } from './pages/ProductsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/" element={<Home />} />
      <Route path="/o/:orgId" element={<Shell />}>
        <Route index element={<Navigate to="products" replace />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
