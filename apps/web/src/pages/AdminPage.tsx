import { Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { dateParts } from '../format';
import { Icon } from '../icons';
import { useMe } from '../queries';
import { useToast } from '../toast';

interface Overview { users: number; disabledUsers: number; organizations: number; suspendedOrganizations: number; activeSessions: number; signin: 'open' | 'owner-only' }
interface AdminOrg { id: string; name: string; slug: string; createdAt: string; deletedAt: string | null; suspendedAt: string | null; members: number }
interface AdminUser { id: string; email: string; name: string; createdAt: string; disabledAt: string | null; organizations: number; lastSeenAt: string | null }
interface AuditRow { id: string; action: string; target: string | null; createdAt: string; requestId: string }

const when = (iso: string | null) => { if (!iso) return '—'; const { date, time } = dateParts(iso); return `${date} ${time}`; };

/** Platform administration for the one super admin. It manages accounts and organizations only; it never shows inventory. */
export function AdminPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!me.data?.user.isSuperAdmin;
  const enabled = isAdmin;
  const overview = useQuery({ enabled, queryKey: ['admin', 'overview'], queryFn: () => api<Overview>('GET', '/admin/overview') });
  const orgs = useQuery({ enabled, queryKey: ['admin', 'orgs'], queryFn: () => api<{ data: AdminOrg[] }>('GET', '/admin/orgs?limit=100').then((r) => r.data) });
  const users = useQuery({ enabled, queryKey: ['admin', 'users'], queryFn: () => api<{ data: AdminUser[] }>('GET', '/admin/users?limit=100').then((r) => r.data) });
  const audit = useQuery({ enabled, queryKey: ['admin', 'audit'], queryFn: () => api<{ data: AuditRow[] }>('GET', '/admin/audit?limit=20').then((r) => r.data) });

  const act = useMutation({
    mutationFn: (v: { path: string; done: string }) => api('POST', v.path, { body: {} }).then(() => v.done),
    onSuccess: (done) => { qc.invalidateQueries({ queryKey: ['admin'] }); toast({ kind: 'success', text: done }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });

  if (me.isLoading) return <div className="boot">Loading…</div>;
  if (!me.data) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/" replace />;

  const o = overview.data;
  const home = me.data.organizations[0] ? `/o/${me.data.organizations[0].id}/products` : '/';
  const failed = [overview, orgs, users].find((q) => q.isError);

  return (
    <div className="dashboard">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar open">
        <div className="sidebar-header"><div className="logo"><div className="logo-icon">SL</div><strong>Platform admin</strong></div></div>
        <div className="sidebar-filters">
          <div className="filter-section">
            <h3>Sign-in</h3>
            <div className="side-value" style={{ fontSize: 16 }}>{o ? (o.signin === 'owner-only' ? 'Owner only' : 'Open to anyone') : '–'}</div>
          </div>
          <div className="filter-section">
            <h3>Scope</h3>
            <p style={{ fontSize: 12, color: '#bdc3c7' }}>You manage accounts and organizations. You cannot open any organization’s products or stock.</p>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label="Main">
          <div className="nav-icons">
            <NavLink to={home} className="nav-icon" title="Back to inventory" aria-label="Back to inventory"><Icon name="grid" size={18} /></NavLink>
            <button className="nav-icon" title="Sign out" aria-label="Sign out" onClick={async () => { await api('POST', '/auth/logout', { body: {} }).catch(() => {}); qc.clear(); nav('/login'); }}><Icon name="logout" size={18} /></button>
          </div>
        </nav>
      </aside>

      <main className="main-content" id="main" tabIndex={-1}>
        <header className="top-header"><div className="breadcrumb"><span>Platform</span><Icon name="chevron" size={12} /><h1 className="current">Overview</h1></div></header>
        {failed && <div className="banner banner-warn" role="alert">Could not load some data: {(failed.error as ApiError).message}</div>}

        <section className="tiles" aria-label="Totals">
          {[['Users', o?.users], ['Organizations', o?.organizations], ['Suspended orgs', o?.suspendedOrganizations], ['Disabled users', o?.disabledUsers], ['Active sessions', o?.activeSessions]].map(([label, n]) => (
            <div className="tile" key={label as string}><div className="num">{n ?? '–'}</div><div className="lbl">{label}</div></div>
          ))}
        </section>

        <section className="admin-section" aria-labelledby="h-orgs">
          <h2 id="h-orgs">Organizations</h2>
          <div className="orders-table-container">
            <table className="orders-table">
              <thead><tr><th>Name</th><th>Members</th><th>Created</th><th>Status</th><th className="actions-col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {orgs.data?.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.name}</strong><div className="time">{g.slug}</div></td>
                    <td>{g.members}</td>
                    <td>{when(g.createdAt)}</td>
                    <td>{g.deletedAt ? <span className="status off">Deleted</span> : g.suspendedAt ? <span className="status warn">Suspended</span> : <span className="status ready">Active</span>}</td>
                    <td className="actions-col">
                      {!g.deletedAt && (g.suspendedAt
                        ? <button className="btn btn-outline cell-btn" onClick={() => act.mutate({ path: `/admin/orgs/${g.id}/restore`, done: `${g.name} restored` })}>Restore</button>
                        : <button className="btn btn-outline cell-btn" onClick={() => { if (confirm(`Suspend ${g.name}? Its members lose access immediately.`)) act.mutate({ path: `/admin/orgs/${g.id}/suspend`, done: `${g.name} suspended` }); }}>Suspend</button>)}
                    </td>
                  </tr>
                ))}
                {orgs.data && !orgs.data.length && <tr><td colSpan={5} className="time">No organizations yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-section" aria-labelledby="h-users">
          <h2 id="h-users">Users</h2>
          <div className="orders-table-container">
            <table className="orders-table">
              <thead><tr><th>User</th><th>Organizations</th><th>Last seen</th><th>Status</th><th className="actions-col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.name}</strong><div className="time">{u.email}</div></td>
                    <td>{u.organizations}</td>
                    <td>{when(u.lastSeenAt)}</td>
                    <td>{u.disabledAt ? <span className="status warn">Disabled</span> : <span className="status ready">Active</span>}</td>
                    <td className="actions-col">
                      {u.id !== me.data!.user.id && (u.disabledAt
                        ? <button className="btn btn-outline cell-btn" onClick={() => act.mutate({ path: `/admin/users/${u.id}/enable`, done: `${u.email} enabled` })}>Enable</button>
                        : <button className="btn btn-outline cell-btn" onClick={() => { if (confirm(`Disable ${u.email}? They are signed out immediately.`)) act.mutate({ path: `/admin/users/${u.id}/disable`, done: `${u.email} disabled` }); }}>Disable</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-section" aria-labelledby="h-audit">
          <h2 id="h-audit">Platform activity</h2>
          {!audit.data?.length ? <p className="hint">No platform actions yet.</p> : (
            <ul className="list">{audit.data.map((a) => <li key={a.id}><span><strong>{a.action}</strong><div className="time">{a.target}</div></span><span className="time">{when(a.createdAt)}</span></li>)}</ul>
          )}
        </section>
      </main>
    </div>
  );
}
