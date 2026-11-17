import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS, PLAN_LIMIT_KEYS, PLAN_LIMIT_LABELS, type PlanFeatureKey, type PlanLimitKey } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { dateParts } from '../format';
import { Icon } from '../icons';
import { useMe } from '../queries';
import { setSupport } from '../support';
import { useToast } from '../toast';

interface Overview { users: number; disabledUsers: number; organizations: number; suspendedOrganizations: number; activeSessions: number; signin: 'open' | 'owner-only' | 'invite-only' }
interface AdminOrg { id: string; name: string; slug: string; createdAt: string; deletedAt: string | null; suspendedAt: string | null; members: number; status: 'pending' | 'active' | 'suspended' | 'deleted' }
interface AdminUser { id: string; email: string; name: string; createdAt: string; disabledAt: string | null; organizations: number; lastSeenAt: string | null }
interface OrgDetail {
  organization: { id: string; name: string; currency: string; createdAt: string; status: string };
  members: { id: string; name: string; email: string; role: string; deactivatedAt: string | null; lastSeenAt: string | null }[];
  pendingInvitations: { id: string; email: string; role: string; expiresAt: string }[];
  counts: { products: number; locations: number; openOrders: number; apiKeys: number; webhooks: number; lastActivityAt: string | null };
  plan: { id: string; overrides: { limits?: Partial<Record<PlanLimitKey, number | null>>; features?: Partial<Record<PlanFeatureKey, boolean>> } | null };
}
interface PlanDef { id: string; name: string; limits: Partial<Record<PlanLimitKey, number | null>>; features: Record<PlanFeatureKey, boolean> }
interface UserDetail {
  user: { id: string; email: string; name: string; createdAt: string; disabledAt: string | null };
  signInMethods: string[];
  organizations: { id: string; name: string; role: string; deactivatedAt: string | null }[];
  sessions: { lastSeenAt: string; userAgent: string | null; country: string | null; via: string }[];
}
interface SecuritySummary { signIns: number; refused: Record<string, number>; rateLimited: number; notMe: number }
interface Security { last24h: SecuritySummary; last7d: SecuritySummary; notable: { repeatedRefusals: { emailHash: string; refusals: number; lastAt: string }[]; ownerDoorRefusals: { at: string; country: string | null; browser: string | null }[]; adminNewCountry: { at: string; email: string; country: string }[]; notMeReports: { at: string; email: string }[] } }
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
  const security = useQuery({ enabled, queryKey: ['admin', 'security'], queryFn: () => api<Security>('GET', '/admin/security') });
  const support = useQuery({ enabled, queryKey: ['admin', 'support'], queryFn: () => api<{ data: { id: string; orgId: string; orgName: string; note: string | null; includeCustomers: boolean; expiresAt: string }[] }>('GET', '/admin/support').then((r) => r.data), refetchInterval: 30_000 });
  const audit = useQuery({ enabled, queryKey: ['admin', 'audit'], queryFn: () => api<{ data: AuditRow[] }>('GET', '/admin/audit?limit=20').then((r) => r.data) });

  const [orgId, setOrgId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const orgDetail = useQuery({ enabled: enabled && !!orgId, queryKey: ['admin', 'org', orgId], queryFn: () => api<OrgDetail>('GET', `/admin/orgs/${orgId}`) });
  const userDetail = useQuery({ enabled: enabled && !!userId, queryKey: ['admin', 'user', userId], queryFn: () => api<UserDetail>('GET', `/admin/users/${userId}`) });
  const [onboard, setOnboard] = useState({ name: '', adminEmail: '', currency: 'USD' });
  const [link, setLink] = useState('');
  const onboardMut = useMutation({
    mutationFn: () => api<{ invitation: { link: string } }>('POST', '/admin/orgs', { body: onboard }),
    onSuccess: (r) => { setLink(r.invitation.link); setOnboard({ name: '', adminEmail: '', currency: 'USD' }); qc.invalidateQueries({ queryKey: ['admin'] }); toast({ kind: 'success', text: 'Business created. Send the admin their link.' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api<{ link: string }>('POST', `/admin/orgs/${id}/resend-invitation`, { body: {} }),
    onSuccess: (r) => { setLink(r.link); toast({ kind: 'success', text: 'New link created' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const transfer = useMutation({
    mutationFn: (v: { org: string; user: string }) => api('POST', `/admin/orgs/${v.org}/transfer-admin`, { body: { userId: v.user } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin'] }); toast({ kind: 'success', text: 'Admin changed' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const signOutUser = useMutation({
    mutationFn: (id: string) => api('POST', `/admin/users/${id}/sign-out`, { body: {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin'] }); toast({ text: 'Signed out everywhere' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const submitOnboard = (e: FormEvent) => { e.preventDefault(); setLink(''); onboardMut.mutate(); };

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
        <div className="sidebar-header"><div className="logo"><img className="brand-mark" src="/logo-symbol-white.png" alt="ShopList" width="40" height="43" /><strong>Platform admin</strong></div></div>
        <div className="sidebar-filters">
          <div className="filter-section">
            <h3>Sign-in</h3>
            <div className="side-value" style={{ fontSize: 16 }}>{o ? ({ 'owner-only': 'Owner only', 'invite-only': 'By invitation', open: 'Open to anyone' }[o.signin]) : '–'}</div>
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

        <section className="admin-section" aria-labelledby="h-support">
          <h2 id="h-support">Support</h2>
          {support.data?.length ? (
            <ul className="list">
              {support.data.map((g) => (
                <li key={g.id}>
                  <span><strong>{g.orgName}</strong>{g.note ? ` · ${g.note}` : ''}<div className="time">Read-only · {g.includeCustomers ? 'customer details included' : 'no customer details'} · open until {when(g.expiresAt)} ({Math.max(1, Math.round((Date.parse(g.expiresAt) - Date.now()) / 60000))} min left)</div></span>
                  <button className="btn btn-primary" onClick={async () => {
                    const d = await api<OrgDetail>('GET', `/admin/orgs/${g.orgId}`);
                    setSupport({ orgId: g.orgId, grantId: g.id, orgName: g.orgName, currency: d.organization.currency, expiresAt: g.expiresAt });
                    nav(`/o/${g.orgId}/products`);
                  }}>Open</button>
                </li>
              ))}
            </ul>
          ) : <p className="hint">No business has opened a support window. When one does, it appears here.</p>}
        </section>

        <section className="admin-section" aria-labelledby="h-sec">
          <h2 id="h-sec">Security</h2>
          {security.data ? (() => {
            const sec = security.data;
            const refused = (x: SecuritySummary) => Object.entries(x.refused);
            const n = sec.notable;
            const flags = n.repeatedRefusals.length + n.ownerDoorRefusals.length + n.adminNewCountry.length + n.notMeReports.length;
            return (
              <>
                <table className="orders-table">
                  <caption className="sr-only">Sign-in activity</caption>
                  <thead><tr><th scope="col">Period</th><th scope="col">Sign-ins</th><th scope="col">Refused</th><th scope="col">Rate-limited</th><th scope="col">“Not me” reports</th></tr></thead>
                  <tbody>
                    {([['Last 24 hours', sec.last24h], ['Last 7 days', sec.last7d]] as const).map(([label, x]) => (
                      <tr key={label}><th scope="row">{label}</th><td>{x.signIns}</td><td>{refused(x).length ? refused(x).map(([r, c]) => `${r.replaceAll('_', ' ')}: ${c}`).join(', ') : 0}</td><td>{x.rateLimited}</td><td>{x.notMe}</td></tr>
                    ))}
                  </tbody>
                </table>
                {flags === 0 ? <p className="hint">Nothing unusual in the last 7 days.</p> : (
                  <ul className="list" aria-label="Notable events">
                    {n.ownerDoorRefusals.map((e, i) => <li key={`g${i}`}><span><strong>Someone else tried the owner’s GitHub door</strong><div className="time">{[e.browser, e.country].filter(Boolean).join(' · ')} · {when(e.at)}</div></span></li>)}
                    {n.repeatedRefusals.map((e) => <li key={e.emailHash}><span><strong>{e.refusals} refused sign-ins for one address in 24 hours</strong><div className="time">Address {e.emailHash.slice(0, 8)} (stored only as a hash) · last {when(e.lastAt)}</div></span></li>)}
                    {n.adminNewCountry.map((e, i) => <li key={`c${i}`}><span><strong>Admin {e.email} signed in from a new country ({e.country})</strong><div className="time">{when(e.at)}</div></span></li>)}
                    {n.notMeReports.map((e, i) => <li key={`m${i}`}><span><strong>{e.email} reported a sign-in that was not theirs</strong><div className="time">{when(e.at)}</div></span></li>)}
                  </ul>
                )}
              </>
            );
          })() : <p className="hint">{security.isLoading ? 'Loading…' : 'Could not load.'}</p>}
        </section>

        <section className="admin-section" aria-labelledby="h-onboard">
          <h2 id="h-onboard">Onboard a business</h2>
          <p className="hint">Creates the business with no members and invites its admin. You never become a member of it.</p>
          <form className="inline-form" onSubmit={submitOnboard}>
            <div className="field"><label htmlFor="ob-name">Business name</label><input id="ob-name" required maxLength={100} value={onboard.name} onChange={(e) => setOnboard({ ...onboard, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="ob-email">Admin email</label><input id="ob-email" type="email" required value={onboard.adminEmail} onChange={(e) => setOnboard({ ...onboard, adminEmail: e.target.value })} /></div>
            <div className="field narrow"><label htmlFor="ob-cur">Currency</label><input id="ob-cur" maxLength={3} value={onboard.currency} onChange={(e) => setOnboard({ ...onboard, currency: e.target.value.toUpperCase() })} /></div>
            <button className="btn btn-primary" disabled={onboardMut.isPending}>Create business</button>
          </form>
          {link && (
            <div className="invite-link" role="status">
              <p>Send this link to the admin. It works once, for their email only, and expires in 7 days. They can also just sign in with that email.</p>
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Admin invitation link" />
              <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(link).then(() => toast({ kind: 'success', text: 'Link copied' }))}>Copy</button>
            </div>
          )}
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
                    <td>{g.status === 'deleted' ? <span className="status off">Deleted</span> : g.status === 'suspended' ? <span className="status warn">Suspended</span> : g.status === 'pending' ? <span className="status low">Waiting for admin</span> : <span className="status ready">Active</span>}</td>
                    <td className="actions-col">
                      <button className="btn btn-outline cell-btn" onClick={() => setOrgId(orgId === g.id ? null : g.id)} aria-expanded={orgId === g.id}>Details</button>
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
          {orgId && orgDetail.data && (
            <div className="card" role="region" aria-label="Business details">
              <h3>{orgDetail.data.organization.name} <span className="time">({orgDetail.data.organization.status})</span></h3>
              <p className="hint">Numbers only. Products, stock and orders are never shown here.</p>
              <div className="tiles">
                {[['Products', orgDetail.data.counts.products], ['Locations', orgDetail.data.counts.locations], ['Open orders', orgDetail.data.counts.openOrders], ['API keys', orgDetail.data.counts.apiKeys], ['Webhooks', orgDetail.data.counts.webhooks]].map(([l, n]) => <div className="tile" key={l as string}><div className="num">{n}</div><div className="lbl">{l}</div></div>)}
              </div>
              <p className="time">Last activity: {when(orgDetail.data.counts.lastActivityAt)}</p>
              <PlanEditor key={orgDetail.data.organization.id + JSON.stringify(orgDetail.data.plan)} orgId={orgDetail.data.organization.id} current={orgDetail.data.plan} />
              <ul className="list">
                {orgDetail.data.members.map((m) => (
                  <li key={m.id}>
                    <span><strong>{m.name}</strong> <span className="tag">{m.role}</span>{m.deactivatedAt && <span className="tag">deactivated</span>}<div className="time">{m.email} · last seen {when(m.lastSeenAt)}</div></span>
                    {m.role !== 'admin' && !m.deactivatedAt && <button className="btn btn-outline cell-btn" onClick={() => { if (confirm(`Make ${m.name} the admin of ${orgDetail.data!.organization.name}?`)) transfer.mutate({ org: orgDetail.data!.organization.id, user: m.id }); }}>Make admin</button>}
                  </li>
                ))}
                {orgDetail.data.pendingInvitations.map((i) => <li key={i.id}><span><strong>{i.email}</strong> <span className="tag">{i.role}</span> <span className="tag">invited</span><div className="time">expires {when(i.expiresAt)}</div></span>{i.role === 'admin' && <button className="btn btn-outline cell-btn" onClick={() => resend.mutate(orgDetail.data!.organization.id)}>New link</button>}</li>)}
              </ul>
            </div>
          )}
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
                      <button className="btn btn-outline cell-btn" onClick={() => setUserId(userId === u.id ? null : u.id)} aria-expanded={userId === u.id}>Details</button>
                      {u.id !== me.data!.user.id && (u.disabledAt
                        ? <button className="btn btn-outline cell-btn" onClick={() => act.mutate({ path: `/admin/users/${u.id}/enable`, done: `${u.email} enabled` })}>Enable</button>
                        : <button className="btn btn-outline cell-btn" onClick={() => { if (confirm(`Disable ${u.email}? They are signed out immediately.`)) act.mutate({ path: `/admin/users/${u.id}/disable`, done: `${u.email} disabled` }); }}>Disable</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {userId && userDetail.data && (
            <div className="card" role="region" aria-label="User details">
              <h3>{userDetail.data.user.name} <span className="time">{userDetail.data.user.email}</span></h3>
              <p className="time">Signs in with: {userDetail.data.signInMethods.join(', ') || 'nothing yet'} · created {when(userDetail.data.user.createdAt)}</p>
              <ul className="list">
                {userDetail.data.organizations.map((g) => <li key={g.id}><span><strong>{g.name}</strong> <span className="tag">{g.role}</span>{g.deactivatedAt && <span className="tag">deactivated</span>}</span></li>)}
              </ul>
              <h4>Active sessions ({userDetail.data.sessions.length})</h4>
              <ul className="list">
                {userDetail.data.sessions.map((x, i) => <li key={i}><span>{x.userAgent?.slice(0, 60) ?? 'Unknown device'}<div className="time">{x.country ?? '—'} · via {x.via} · {when(x.lastSeenAt)}</div></span></li>)}
              </ul>
              {userDetail.data.sessions.length > 0 && <button className="btn btn-outline" onClick={() => signOutUser.mutate(userDetail.data!.user.id)}>Sign out everywhere</button>}
            </div>
          )}
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

/** Pick a plan for one business and override single limits or features. A blank limit means "use the plan's value". */
function PlanEditor({ orgId, current }: { orgId: string; current: OrgDetail['plan'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api<{ data: PlanDef[] }>('GET', '/admin/plans').then((r) => r.data) });
  const [planId, setPlanId] = useState(current.id);
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, current.overrides?.limits?.[k] == null ? '' : String(current.overrides.limits[k])])));
  const [features, setFeatures] = useState<Record<string, string>>(() => Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, current.overrides?.features?.[k] === undefined ? '' : String(current.overrides.features[k])])));
  const save = useMutation({
    mutationFn: () => {
      const l = Object.fromEntries(PLAN_LIMIT_KEYS.filter((k) => limits[k] !== '').map((k) => [k, Number(limits[k])]));
      const f = Object.fromEntries(PLAN_FEATURE_KEYS.filter((k) => features[k] !== '').map((k) => [k, features[k] === 'true']));
      return api('PATCH', `/admin/orgs/${orgId}/plan`, { body: { plan: planId, overrides: Object.keys(l).length || Object.keys(f).length ? { limits: l, features: f } : null } });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin', 'org', orgId] }); toast({ kind: 'success', text: 'Plan saved' }); },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not save the plan.' }),
  });
  const base = plans.data?.find((p) => p.id === planId);
  return (
    <details className="plan-editor">
      <summary>Plan: {plans.data?.find((p) => p.id === current.id)?.name ?? current.id}{current.overrides ? ' (with overrides)' : ''}</summary>
      <form className="settings-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="field"><label htmlFor={`pl-${orgId}`}>Plan</label>
          <select id={`pl-${orgId}`} value={planId} onChange={(e) => setPlanId(e.target.value)}>{plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        {PLAN_LIMIT_KEYS.map((k) => (
          <div className="field" key={k}><label htmlFor={`pl-${orgId}-${k}`}>{PLAN_LIMIT_LABELS[k]}</label>
            <input id={`pl-${orgId}-${k}`} type="number" min={0} inputMode="numeric" placeholder={base ? (base.limits[k] == null ? 'No limit' : String(base.limits[k])) : ''} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} /></div>
        ))}
        {PLAN_FEATURE_KEYS.map((k) => (
          <div className="field" key={k}><label htmlFor={`pf-${orgId}-${k}`}>{PLAN_FEATURE_LABELS[k]}</label>
            <select id={`pf-${orgId}-${k}`} value={features[k]} onChange={(e) => setFeatures({ ...features, [k]: e.target.value })}>
              <option value="">Plan default ({base ? (base.features[k] ? 'on' : 'off') : '…'})</option><option value="true">On</option><option value="false">Off</option>
            </select></div>
        ))}
        <button className="btn btn-primary" disabled={save.isPending}>Save plan</button>
      </form>
    </details>
  );
}
