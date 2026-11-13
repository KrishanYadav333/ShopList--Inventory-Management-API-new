import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../icons';
import { useDashboard, useLocations, useMe, canWrite, type OrgSummary } from '../queries';
import { AdjustDialog } from './AdjustDialog';
import { CommandPalette } from './CommandPalette';
import { ProductDialog } from './ProductDialog';

export interface ShellContext {
  org: OrgSummary;
  openNew: () => void;
  openAdjust: (productId?: string) => void;
  openEdit: (productId: string) => void;
}
export const useShell = () => useOutletContext<ShellContext>();

type Dialog = { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'adjust'; productId?: string } | { kind: 'palette' } | null;

export function Shell() {
  const { orgId = '' } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const org = me.data?.organizations.find((o) => o.id === orgId);
  const dash = useDashboard(orgId);
  const locations = useLocations(orgId);

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
      else if (!typing && !e.metaKey && !e.ctrlKey && e.key === 'n' && org && canWrite(org.role)) { e.preventDefault(); setDialog({ kind: 'new' }); }
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
    openAdjust: (productId) => setDialog({ kind: 'adjust', productId }),
    openEdit: (id) => setDialog({ kind: 'edit', id }),
  };

  return (
    <div className="dashboard">
      <a className="skip" href="#main">Skip to content</a>
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon">SL</div>
            <select className="org-switch" aria-label="Organization" value={orgId} onChange={(e) => e.target.value === '__new' ? nav('/') : nav(`/o/${e.target.value}/products`)}>
              {me.data!.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="__new">+ New organization…</option>
            </select>
          </div>
        </div>

        <div className="sidebar-filters">
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

          {d && (
            <div className="filter-section">
              <h3>Inventory value</h3>
              <div className="side-value">{new Intl.NumberFormat(undefined, { style: 'currency', currency: org.currency }).format(d.inventoryValueMinor / 100)}</div>
            </div>
          )}
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          <div className="nav-icons">
            <NavLink to={`/o/${orgId}/products`} className="nav-icon" title="Products" aria-label="Products"><Icon name="grid" size={18} /></NavLink>
            <NavLink to={`/o/${orgId}/history`} className="nav-icon" title="Stock history" aria-label="Stock history"><Icon name="clock" size={18} /></NavLink>
            <NavLink to={`/o/${orgId}/settings`} className="nav-icon" title="Settings" aria-label="Settings"><Icon name="cog" size={18} /></NavLink>
            {me.data?.user.isSuperAdmin && <NavLink to="/admin" className="nav-icon" title="Platform admin" aria-label="Platform admin"><Icon name="shield" size={18} /></NavLink>}
            <button className="nav-icon" title="Sign out" aria-label="Sign out" onClick={async () => { await api('POST', '/auth/logout', { body: {} }).catch(() => {}); qc.clear(); nav('/login'); }}><Icon name="logout" size={18} /></button>
          </div>
        </nav>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      <main className="main-content" id="main" tabIndex={-1}>
        {!online && <div className="banner banner-warn" role="status">You are offline. Showing saved data; changes are disabled until you reconnect.</div>}
        <Outlet context={ctx} />
      </main>

      {dialog?.kind === 'new' && <ProductDialog org={org} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <ProductDialog org={org} productId={dialog.id} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'adjust' && <AdjustDialog org={org} productId={dialog.productId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'palette' && <CommandPalette org={org} onClose={() => setDialog(null)} onAdjust={(id) => setDialog({ kind: 'adjust', productId: id })} onEdit={(id) => setDialog({ kind: 'edit', id })} onNew={() => setDialog({ kind: 'new' })} />}
      <button className="menu-fab" aria-label="Open menu" onClick={() => setMenuOpen((v) => !v)}><Icon name="sliders" size={18} /></button>
    </div>
  );
}
