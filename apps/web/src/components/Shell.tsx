import { useEffect, useState } from 'react';
import type { PlanFeatureKey } from '@shoplist/shared';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../icons';
import { NotificationBell } from './NotificationBell';
import { Announcements } from './Announcements';
import { clearSupport, getSupport } from '../support';
import { useDashboard, useLocations, useMe, usePlan, canDo, type OrgSummary } from '../queries';
import { AdjustDialog } from './AdjustDialog';
import { OrderDialog } from './OrderDialog';
import { CommandPalette } from './CommandPalette';
import { ProductDialog } from './ProductDialog';

export interface ShellContext {
  org: OrgSummary;
  openNew: () => void;
  openOrder: () => void;
  openAdjust: (productId?: string) => void;
  openEdit: (productId: string) => void;
}
export const useShell = () => useOutletContext<ShellContext>();

type Dialog = { kind: 'order' } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'adjust'; productId?: string } | { kind: 'palette' } | null;

export function Shell() {
  const { orgId = '' } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const support = me.data?.user.isSuperAdmin ? getSupport() : null;
  const supportOrg = support && support.orgId === orgId ? support : null;
  // The owner is no member: inside a support window the business is shown as if viewed by a read-only person.
  const org = me.data?.organizations.find((o) => o.id === orgId) ?? (supportOrg ? { id: orgId, name: supportOrg.orgName, slug: '', currency: supportOrg.currency, role: (supportOrg.mode === 'assist' ? 'manager' : 'viewer') as 'manager' | 'viewer' } : undefined);
  const dash = useDashboard(orgId);
  const locations = useLocations(orgId);
  const plan = usePlan(orgId);
  const feat = (k: PlanFeatureKey) => plan.data?.features[k] !== false; // until the plan loads, show everything

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); };
  }, []);

  // Keyboard: Ctrl/Cmd+K palette, "/" search, "n" new product.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setDialog({ kind: 'palette' }); }
      else if (!typing && !e.metaKey && !e.ctrlKey && e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('.search-input')?.focus(); }
      else if (!typing && !e.metaKey && !e.ctrlKey && e.key === 'n' && org && canDo(org.role, location.pathname.endsWith('/orders') ? 'orders:write' : 'products:write')) { e.preventDefault(); setDialog({ kind: location.pathname.endsWith('/orders') ? 'order' : 'new' } as Dialog); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [org]);

  if (me.isLoading) return <div className="boot">Loading…</div>;
  if (!org) {
    return (
      <div className="boot">
        <h2>Organization not found</h2>
        <p>You may not have access to it, or it was deleted.</p>
        <button className="btn btn-primary" onClick={() => nav('/')}>Go to my organizations</button>
      </div>
    );
  }

  const isOrders = location.pathname.endsWith('/orders');
  const showFilters = isOrders || location.pathname.endsWith('/products');
  const stock = params.get('stock');
  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
    if (!location.pathname.endsWith('/products')) nav(`/o/${orgId}/products?${next}`);
  };
  const d = dash.data;
  const ctx: ShellContext = {
    org,
    openNew: () => setDialog({ kind: 'new' }),
    openOrder: () => setDialog({ kind: 'order' }),
    openAdjust: (productId) => setDialog({ kind: 'adjust', productId }),
    openEdit: (id) => setDialog({ kind: 'edit', id }),
  };

  return (
    <div className="dashboard">
      <a className="skip" href="#main">Skip to content</a>
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <img className="brand-mark" src="/logo-symbol-white.png" alt="ShopList" width="40" height="43" />
            <select className="org-switch" aria-label="Organization" value={orgId} onChange={(e) => e.target.value === '__new' ? nav('/') : nav(`/o/${e.target.value}/orders`)}>
              {me.data!.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="__new">+ New organization…</option>
            </select>
          </div>
        </div>

        <nav className="side-nav" aria-label="Main">
          <p className="nav-group">Work</p>
          {feat('orders') && <NavLink to={`/o/${orgId}/orders`} className="nav-item"><Icon name="cart" size={18} /><span className="nav-label">Orders</span></NavLink>}
          <NavLink to={`/o/${orgId}/products`} className="nav-item"><Icon name="grid" size={18} /><span className="nav-label">Products</span></NavLink>
          <NavLink to={`/o/${orgId}/history`} className="nav-item"><Icon name="clock" size={18} /><span className="nav-label">Stock history</span></NavLink>
          {canDo(org.role, 'customers:read') && <NavLink to={`/o/${orgId}/customers`} className="nav-item"><Icon name="users" size={18} /><span className="nav-label">Customers</span></NavLink>}
          {canDo(org.role, 'stock:write') && <NavLink to={`/o/${orgId}/counts`} className="nav-item"><Icon name="scan" size={18} /><span className="nav-label">Counts</span></NavLink>}
          {feat('purchasing') && <NavLink to={`/o/${orgId}/purchasing`} className="nav-item"><Icon name="truck" size={18} /><span className="nav-label">Purchasing</span></NavLink>}
          {(feat('reports') && (supportOrg || canDo(org.role, 'reports:read')) || (feat('approvals') && !supportOrg)) && <p className="nav-group">Review</p>}
          {feat('reports') && (supportOrg || canDo(org.role, 'reports:read')) && <NavLink to={`/o/${orgId}/reports`} className="nav-item"><Icon name="chart" size={18} /><span className="nav-label">Reports</span></NavLink>}
          {feat('approvals') && !supportOrg && <NavLink to={`/o/${orgId}/approvals`} className="nav-item"><Icon name="check" size={18} /><span className="nav-label">Approvals</span></NavLink>}
        </nav>

        {showFilters && <div className="sidebar-filters">
          {isOrders ? (
            <div className="filter-section">
              <h3>Orders</h3>
              <div className="status-filters" role="group" aria-label="Order status">
                {([
                  [null, 'All orders', d ? Object.values(d.orders).reduce((x, y) => x + y, 0) : undefined, ''],
                  ['payment_required', 'Payment required', d?.orders.payment_required, 'primary'],
                  ['waiting_for_stock', 'Waiting for stock', d?.orders.waiting_for_stock, 'warning'],
                  ['ready_to_ship', 'Ready to ship', d?.orders.ready_to_ship, 'primary'],
                  ['shipped', 'Shipped', d?.orders.shipped, ''],
                  ['cancelled', 'Cancelled', d?.orders.cancelled, ''],
                ] as const).map(([value, label, count, tone]) => (
                  <button key={label} className={`status-item${(params.get('state') ?? null) === value ? ' active' : ''}`} aria-pressed={(params.get('state') ?? null) === value} onClick={() => setFilter('state', value)}>
                    <span className="status-label">{label}</span>
                    <span className={`status-count ${tone}`}>{count ?? '–'}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
          <div className="filter-section">
            <h3>Stock status</h3>
            <div className="status-filters" role="group" aria-label="Stock status">
              {([
                [null, 'All products', d?.products, ''],
                ['in', 'In stock', d ? d.products - d.outOfStock : undefined, 'primary'],
                ['low', 'Low stock', d?.lowStock, 'warning'],
                ['out', 'Out of stock', d?.outOfStock, 'warning'],
              ] as const).map(([value, label, count, tone]) => (
                <button key={label} className={`status-item${(stock ?? null) === value ? ' active' : ''}`} aria-pressed={(stock ?? null) === value} onClick={() => setFilter('stock', value)}>
                  <span className="status-label">{label}</span>
                  <span className={`status-count ${tone}`}>{count ?? '–'}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="filter-section">
            <h3>Filters</h3>
            <div className="filter-controls">
              <div className="filter-control">
                <label htmlFor="f-loc">Location</label>
                <select id="f-loc" value={params.get('location') ?? ''} onChange={(e) => setFilter('location', e.target.value || null)}>
                  <option value="">All locations</option>
                  {locations.data?.filter((l) => !l.archivedAt).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div className="filter-control">
                <label htmlFor="f-tag">Tag</label>
                <input id="f-tag" className="side-input" placeholder="e.g. office" value={params.get('tag') ?? ''} onChange={(e) => setFilter('tag', e.target.value.trim() || null)} />
              </div>
              <div className="filter-control">
                <label htmlFor="f-sort">Sort by</label>
                <select id="f-sort" value={params.get('sort') ?? '-updatedAt'} onChange={(e) => setFilter('sort', e.target.value === '-updatedAt' ? null : e.target.value)}>
                  <option value="-updatedAt">Recently updated</option>
                  <option value="name">Name (A–Z)</option>
                </select>
              </div>
            </div>
          </div>

          {d && d.inventoryValueMinor != null && (
            <div className="filter-section">
              <h3>Inventory value</h3>
              <div className="side-value">{new Intl.NumberFormat(undefined, { style: 'currency', currency: org.currency }).format(d.inventoryValueMinor / 100)}</div>
            </div>
          )}
                    </>
          )}
        </div>}
        <div className="side-foot">
          {!supportOrg && <NavLink to={`/o/${orgId}/settings`} className="nav-item"><Icon name="cog" size={18} /><span className="nav-label">Settings</span></NavLink>}
          {!supportOrg && <NotificationBell />}
          {me.data?.user.isSuperAdmin && <NavLink to="/admin" className="nav-item"><Icon name="shield" size={18} /><span className="nav-label">Platform admin</span></NavLink>}
          <button className="nav-item" onClick={async () => { await api('POST', '/auth/logout', { body: {} }).catch(() => {}); qc.clear(); location.assign('/login'); /* a full load, so nothing from the last person stays in memory */ }}><Icon name="logout" size={18} /><span className="nav-label">Sign out</span></button>
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      <main className="main-content" id="main" tabIndex={-1}>
        {!online && <div className="banner banner-warn" role="status">You are offline. Showing saved data; changes are disabled until you reconnect.</div>}
        <Announcements />
        {org.deleteAfter && (
          <div className="banner banner-warn" role="status">
            <strong>{org.name} is scheduled for deletion on {new Date(org.deleteAfter).toLocaleDateString()}.</strong> It is read-only until then.{org.role === 'admin' && <> <NavLink to={`/o/${orgId}/settings`}>Cancel deletion in Settings</NavLink></>}
          </div>
        )}
        {supportOrg && (
          <div className="banner banner-support" role="status">
            <strong>{supportOrg.mode === 'assist' ? 'Support access (can make changes) to' : 'Support access (read-only) to'} {supportOrg.orgName}.</strong> {supportOrg.mode === 'assist' ? 'You can edit products, stock and orders, but not delete. Changes appear as "ShopList support". Ends at' : 'Read-only. Ends at'} {new Date(supportOrg.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Every page you open is logged.
            <button className="btn btn-outline" onClick={() => { clearSupport(); nav('/admin'); }}>Leave</button>
          </div>
        )}
        <Outlet context={ctx} />
      </main>

      {dialog?.kind === 'order' && <OrderDialog org={org} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new' && <ProductDialog org={org} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <ProductDialog org={org} productId={dialog.id} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'adjust' && <AdjustDialog org={org} productId={dialog.productId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'palette' && <CommandPalette org={org} onClose={() => setDialog(null)} onAdjust={(id) => setDialog({ kind: 'adjust', productId: id })} onEdit={(id) => setDialog({ kind: 'edit', id })} onNew={() => setDialog({ kind: 'new' })} />}
      <button className="menu-fab" aria-label="Open menu" onClick={() => setMenuOpen((v) => !v)}><Icon name="sliders" size={18} /></button>
    </div>
  );
}
