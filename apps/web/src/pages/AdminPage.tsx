import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS, PLAN_LIMIT_KEYS, PLAN_LIMIT_LABELS, type PlanFeatureKey, type PlanLimitKey } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { dateParts } from '../format';
import { Icon } from '../icons';
import { useMe } from '../queries';
import { setSupport } from '../support';
import { Announcements } from '../components/Announcements';
import { useToast } from '../toast';

interface Overview { users: number; disabledUsers: number; organizations: number; suspendedOrganizations: number; deletingOrganizations: number; newOrganizations: number; activeSessions: number; attention: { kind: string; label: string; count: number; link: string; error?: boolean }[]; signin: 'open' | 'owner-only' | 'invite-only' }
interface AdminOrg { id: string; name: string; slug: string; createdAt: string; deletedAt: string | null; suspendedAt: string | null; members: number; status: 'pending' | 'active' | 'suspended' | 'deleted' }
interface AdminUser { id: string; email: string; name: string; createdAt: string; disabledAt: string | null; organizations: number; lastSeenAt: string | null }
interface OrgDetail {
  organization: { id: string; name: string; currency: string; createdAt: string; status: string; deleteAfter?: string | null };
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
interface UsageDay { date: string; requests: number; errors: number; cpuP50Us: number; cpuP99Us: number; d1RowsRead: number; d1RowsWritten: number; doRequests: number; queueOps: number }
interface Usage { days: UsageDay[]; limits: Record<string, number>; cpuLimitUs: number; labels: Record<string, string>; warnings: { metric: string; label: string; pct: number }[]; businesses: { orgId: string; name: string; requests: number; errors: number; products: number | null; members: number; lastActivityAt: string | null }[] }
interface BackupRow { orgId: string; name: string; day: string | null; ok: boolean | null; sizeBytes: number | null; rows: number | null; error: string | null; at: string | null; days: string[] }
interface Ann { id: string; message: string; severity: string; audience: string; orgId: string | null; startsAt: string; endsAt: string | null; endedAt: string | null }
interface Maint { id: string; orgId: string | null; orgName: string | null; message: string; startedAt: string }
interface Alert { id: string; kind: string; severity: 'high' | 'medium'; label: string; who: string | null; count: number; firstAt: string; lastAt: string; state: 'open' | 'investigating' | 'resolved' | 'dismissed'; note: string | null }
interface HealthRow { id: string; name: string; day: string | null; score: number | null; status: 'healthy' | 'watch' | 'at_risk' | 'new' | 'suspended' | 'deleting' | 'not_scored'; parts: { activity: number; adminSignIn: number; backups: number; headroom: number } | null }
interface JobStatus { job: string; every: 'hourly' | 'daily'; state: 'ok' | 'failed' | 'not running' | 'no runs yet'; lastAt: string | null; error: string | null; detail: Record<string, number> | null; failures7d: number }
interface SystemStatus { jobs: JobStatus[]; lastBackup: { day: string; ok: number; failed: number } | null; email: { sentToday: number; failedToday: number; dailyCap: number; configured: boolean }; healthUrl: string }
interface AuditRow { id: string; action: string; target: string | null; createdAt: string; requestId: string }

const PAGES = [
  { key: 'overview', label: 'Overview', icon: 'grid' },
  { key: 'businesses', label: 'Businesses', icon: 'cart' },
  { key: 'people', label: 'People', icon: 'users' },
  { key: 'security', label: 'Security', icon: 'shield' },
  { key: 'operations', label: 'Operations', icon: 'chart' },
  { key: 'notices', label: 'Notices', icon: 'bell' },
  { key: 'support', label: 'Support', icon: 'sliders' },
  { key: 'activity', label: 'Activity', icon: 'clock' },
] as const;

const when = (iso: string | null) => { if (!iso) return '—'; const { date, time } = dateParts(iso); return `${date} ${time}`; };

/** Platform administration for the one super admin. It manages accounts and organizations only; it never shows inventory. */
export function AdminPage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = !!me.data?.user.isSuperAdmin;
  const enabled = isAdmin;
  const { page: pageParam } = useParams();
  const page = PAGES.some((x) => x.key === pageParam) ? pageParam! : 'overview';
  const on = (...pages: string[]) => enabled && pages.includes(page);
  const overview = useQuery({ enabled, queryKey: ['admin', 'overview'], queryFn: () => api<Overview>('GET', '/admin/overview') });
  const orgs = useQuery({ enabled: on('businesses', 'notices'), queryKey: ['admin', 'orgs'], queryFn: () => api<{ data: AdminOrg[] }>('GET', '/admin/orgs?limit=100').then((r) => r.data) });
  const users = useQuery({ enabled: on('people', 'businesses'), queryKey: ['admin', 'users'], queryFn: () => api<{ data: AdminUser[] }>('GET', '/admin/users?limit=100').then((r) => r.data) });
  const usage = useQuery({ enabled: on('operations'), queryKey: ['admin', 'usage'], queryFn: () => api<Usage>('GET', '/admin/usage'), retry: false, staleTime: 120_000 });
  const backups = useQuery({ enabled: on('operations'), queryKey: ['admin', 'backups'], queryFn: () => api<{ data: BackupRow[] }>('GET', '/admin/backups').then((r) => r.data) });
  const [rehearse, setRehearse] = useState<{ orgId: string; day: string; email: string } | null>(null);
  const runBackup = useMutation({ mutationFn: (orgId?: string) => api('POST', '/admin/backups/run', { body: orgId ? { orgId } : {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin', 'backups'] }); toast({ kind: 'success', text: 'Backup finished' }); }, onError: (e) => toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Backup failed.' }) });
  const restoreCopy = useMutation({
    mutationFn: (r: { orgId: string; day: string; email: string }) => api<{ organization: { id: string; name: string }; invitation: { link: string } | null }>('POST', `/admin/backups/${r.orgId}/${r.day}/restore`, { body: r.email ? { adminEmail: r.email } : {} }),
    onSuccess: (r) => { setRehearse(null); qc.invalidateQueries({ queryKey: ['admin'] }); toast({ kind: 'success', text: `Created “${r.organization.name}”.${r.invitation ? ' The invitation was emailed to its admin.' : ''}` }); },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Restore failed.' }),
  });
  const health = useQuery({ enabled: on('operations'), queryKey: ['admin', 'health'], queryFn: () => api<{ data: HealthRow[]; weights: Record<string, number> }>('GET', '/admin/health'), staleTime: 300_000 });
  const status = useQuery({ enabled: on('operations'), queryKey: ['admin', 'status'], queryFn: () => api<SystemStatus>('GET', '/admin/status'), refetchInterval: 60_000 });
  const alerts = useQuery({ enabled: on('security'), queryKey: ['admin', 'alerts'], queryFn: () => api<{ data: Alert[] }>('GET', '/admin/security/alerts').then((r) => r.data), refetchInterval: 60_000 });
  const [alertNote, setAlertNote] = useState<Record<string, string>>({});
  const setAlert = useMutation({
    mutationFn: (v: { id: string; state: Alert['state'] }) => api('PATCH', `/admin/security/alerts/${v.id}`, { body: { state: v.state, note: alertNote[v.id]?.trim() || undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin', 'alerts'] }); toast({ text: 'Alert updated' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const security = useQuery({ enabled: on('security'), queryKey: ['admin', 'security'], queryFn: () => api<Security>('GET', '/admin/security') });
  const support = useQuery({ enabled: on('support'), queryKey: ['admin', 'support'], queryFn: () => api<{ data: { id: string; orgId: string; orgName: string; note: string | null; includeCustomers: boolean; mode: 'view' | 'assist'; expiresAt: string }[] }>('GET', '/admin/support').then((r) => r.data), refetchInterval: 30_000 });
  const anns = useQuery({ enabled: on('notices'), queryKey: ['admin', 'announcements'], queryFn: () => api<{ data: Ann[] }>('GET', '/admin/announcements').then((r) => r.data) });
  const maint = useQuery({ enabled: on('notices'), queryKey: ['admin', 'maintenance'], queryFn: () => api<{ data: Maint[] }>('GET', '/admin/maintenance').then((r) => r.data) });
  const [ann, setAnn] = useState({ message: '', severity: 'info', audience: 'everyone', orgId: '' });
  const [mnt, setMnt] = useState({ orgId: '', message: '' });
  const refreshNotices = () => { qc.invalidateQueries({ queryKey: ['admin', 'announcements'] }); qc.invalidateQueries({ queryKey: ['admin', 'maintenance'] }); qc.invalidateQueries({ queryKey: ['announcements'] }); };
  const failMsg = (e: unknown) => toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong.' });
  const addAnn = useMutation({ mutationFn: () => api('POST', '/admin/announcements', { body: { message: ann.message, severity: ann.severity, audience: ann.audience, orgId: ann.audience === 'org' ? ann.orgId : undefined } }), onSuccess: () => { setAnn({ ...ann, message: '' }); refreshNotices(); toast({ kind: 'success', text: 'Published' }); }, onError: failMsg });
  const endAnn = useMutation({ mutationFn: (id: string) => api('DELETE', `/admin/announcements/${id}`), onSuccess: refreshNotices, onError: failMsg });
  const startMnt = useMutation({ mutationFn: () => api('POST', '/admin/maintenance', { body: { orgId: mnt.orgId || undefined, message: mnt.message || undefined } }), onSuccess: () => { setMnt({ orgId: '', message: '' }); refreshNotices(); toast({ text: 'Maintenance is on: writes are refused, reads work' }); }, onError: failMsg });
  const stopMnt = useMutation({ mutationFn: (id: string) => api('DELETE', `/admin/maintenance/${id}`), onSuccess: () => { refreshNotices(); toast({ text: 'Maintenance is off' }); }, onError: failMsg });
  const audit = useQuery({ enabled: on('activity'), queryKey: ['admin', 'audit'], queryFn: () => api<{ data: AuditRow[] }>('GET', '/admin/audit?limit=20').then((r) => r.data) });

  const [orgId, setOrgId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const orgDetail = useQuery({ enabled: enabled && !!orgId, queryKey: ['admin', 'org', orgId], queryFn: () => api<OrgDetail>('GET', `/admin/orgs/${orgId}`) });
  const userDetail = useQuery({ enabled: enabled && !!userId, queryKey: ['admin', 'user', userId], queryFn: () => api<UserDetail>('GET', `/admin/users/${userId}`) });
  const [onboard, setOnboard] = useState({ name: '', adminEmail: '', currency: 'USD' });
  const [link, setLink] = useState('');
  const onboardMut = useMutation({
    mutationFn: () => api<{ invitation: { link: string } }>('POST', '/admin/orgs', { body: onboard }),
    onSuccess: (r) => { setLink(r.invitation.link); setOnboard({ name: '', adminEmail: '', currency: 'USD' }); qc.invalidateQueries({ queryKey: ['admin'] }); toast({ kind: 'success', text: 'Business created. The invitation was emailed to its admin.' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api<{ link: string }>('POST', `/admin/orgs/${id}/resend-invitation`, { body: {} }),
    onSuccess: (r) => { setLink(r.link); toast({ kind: 'success', text: 'New invitation emailed' }); },
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
  const failed = [overview, orgs, users].find((q) => q.isError);
  const title = PAGES.find((x) => x.key === page)!.label;

  return (
    <div className="dashboard">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar open">
        <div className="sidebar-header"><div className="logo"><img className="brand-mark" src="/logo-symbol-white.png" alt="ShopList" width="40" height="43" /><strong>Platform admin</strong></div></div>
        <nav className="side-nav" aria-label="Platform">
          {PAGES.map((x) => <NavLink key={x.key} to={x.key === 'overview' ? '/admin' : `/admin/${x.key}`} end className={() => `nav-item${x.key === page ? ' active' : ''}`} aria-current={x.key === page ? 'page' : undefined}><Icon name={x.icon} size={18} /><span className="nav-label">{x.label}</span></NavLink>)}
        </nav>
        <div className="side-foot">
          <p className="side-note">Sign-in: {o ? ({ 'owner-only': 'owner only', 'invite-only': 'by invitation', open: 'open to anyone' }[o.signin]) : '...'}</p>
          <button className="nav-item" onClick={async () => { await api('POST', '/auth/logout', { body: {} }).catch(() => {}); qc.clear(); nav('/login'); }}><Icon name="logout" size={18} /><span className="nav-label">Sign out</span></button>
        </div>
      </aside>

      <main className="main-content" id="main" tabIndex={-1}>
        <header className="top-header"><div className="breadcrumb"><span>Platform</span><Icon name="chevron" size={12} /><h1 className="current">{title}</h1></div></header>
        <Announcements />
        {failed && <div className="banner banner-warn" role="alert">Could not load some data: {(failed.error as ApiError).message}</div>}

        {page === 'overview' && (
        <section className="admin-section" aria-labelledby="h-attention">
          <h2 id="h-attention">Needs attention</h2>
          {!o ? <p className="hint">Loading…</p> : !o.attention.length ? <p className="hint" role="status">Nothing needs you right now. Backups, jobs, security and usage are all fine.</p> : (
            <ul className="list" aria-label="Items that need attention">
              {o.attention.map((a) => (
                <li key={a.kind}><span>{a.error ? <span className="pill warn">unchecked</span> : null} {a.label}</span><NavLink className="btn btn-outline" to={a.link}>Open</NavLink></li>
              ))}
            </ul>
          )}
        </section>
      )}
      {page === 'overview' && (
        <section className="tiles" aria-label="Totals">
          {[['Businesses', o?.organizations], ['New in 30 days', o?.newOrganizations], ['Suspended', o?.suspendedOrganizations], ['Scheduled for deletion', o?.deletingOrganizations], ['People', o?.users], ['Disabled people', o?.disabledUsers], ['Active sessions', o?.activeSessions]].map(([label, n]) => (
            <div className="tile" key={label as string}><div className="num">{n ?? '–'}</div><div className="lbl">{label}</div></div>
          ))}
        </section>)}

        {page === 'operations' && (
        <section className="admin-section" aria-labelledby="h-status">
          <h2 id="h-status">System status</h2>
          {status.isError ? <p className="hint">Could not load the status.</p> : !status.data ? <p className="hint">Loading…</p> : (
            <>
              <div className="orders-table-container"><table className="orders-table">
                <thead><tr><th>Job</th><th>Runs</th><th>Last run</th><th>Result</th><th>Failures in 7 days</th></tr></thead>
                <tbody>{status.data.jobs.map((j) => (
                  <tr key={j.job}>
                    <td>{j.job}</td><td>{j.every}</td><td>{j.lastAt ? when(j.lastAt) : 'never'}</td>
                    <td><span className={`pill ${j.state === 'ok' ? 'ok' : j.state === 'no runs yet' ? '' : 'bad'}`}>{j.state}</span>{j.error ? <div className="time">{j.error}</div> : null}</td>
                    <td>{j.failures7d}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <ul className="list" aria-label="Other checks">
                <li><span>Last nightly backup<div className="time">{status.data.lastBackup ? `${status.data.lastBackup.day}: ${status.data.lastBackup.ok} saved, ${status.data.lastBackup.failed} failed` : 'No backup has run yet.'}</div></span></li>
                <li><span>Email today<div className="time">{status.data.email.configured ? `${status.data.email.sentToday} of ${status.data.email.dailyCap} sent, ${status.data.email.failedToday} failed` : 'Email is not set up (no key).'}</div></span></li>
                <li><span>Is the whole site up?<div className="time">Only an outside checker can tell you when the site itself is down. Point a free uptime checker at {status.data.healthUrl}</div></span></li>
              </ul>
            </>
          )}
        </section>
      )}
      {page === 'operations' && (
        <section className="admin-section" aria-labelledby="h-health">
          <h2 id="h-health">Business health</h2>
          <p className="hint">Scored each night from four parts: activity in the last 14 days, an admin seen recently, nightly backups, and room under the plan limits. Counts only; nothing about products or customers is read. It is a prompt to look, not a verdict.</p>
          {health.isError ? <p className="hint">Could not load.</p> : !health.data ? <p className="hint">Loading…</p> : !health.data.data.length ? <p className="hint">No businesses yet.</p> : (
            <div className="orders-table-container"><table className="orders-table">
              <caption className="sr-only">Business health, worst first</caption>
              <thead><tr><th>Business</th><th>Status</th><th>Score</th><th>Activity /{health.data.weights.activity}</th><th>Admin seen /{health.data.weights.adminSignIn}</th><th>Backups /{health.data.weights.backups}</th><th>Headroom /{health.data.weights.headroom}</th></tr></thead>
              <tbody>{health.data.data.map((h) => (
                <tr key={h.id}>
                  <td>{h.name}</td>
                  <td><span className={`pill ${h.status === 'healthy' ? 'ok' : h.status === 'at_risk' ? 'bad' : h.status === 'watch' ? 'warn' : ''}`}>{({ healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk', new: 'New', suspended: 'Suspended', deleting: 'Deleting', not_scored: 'Not scored yet' })[h.status]}</span></td>
                  <td>{h.score ?? '-'}</td>
                  <td>{h.parts?.activity ?? '-'}</td><td>{h.parts?.adminSignIn ?? '-'}</td><td>{h.parts?.backups ?? '-'}</td><td>{h.parts?.headroom ?? '-'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
      {page === 'operations' && (
        <section className="admin-section" aria-labelledby="h-backups">
          <h2 id="h-backups">Nightly backups</h2>
          <p className="hint">Each business is copied every night at 03:00 UTC and kept 30 days. You see when and how big, never the contents. To rehearse or recover, load a copy into a new business.</p>
          <p><button className="btn btn-outline" disabled={runBackup.isPending} onClick={() => runBackup.mutate(undefined)}>Back up everything now</button></p>
          {backups.data?.length ? (
            <table className="orders-table">
              <caption className="sr-only">Latest backup of each business</caption>
              <thead><tr><th scope="col">Business</th><th scope="col">Last backup</th><th scope="col">Size</th><th scope="col">Days kept</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {backups.data.map((b) => (
                  <tr key={b.orgId}>
                    <th scope="row">{b.name}</th>
                    <td>{b.ok === null ? 'Never' : b.ok ? when(b.at) : <span className="field-error">Failed: {b.error}</span>}</td>
                    <td>{b.sizeBytes ? `${Math.max(1, Math.round(b.sizeBytes / 1024))} KB` : '—'}</td>
                    <td>{b.days.length}</td>
                    <td>
                      <button className="btn btn-outline cell-btn" onClick={() => runBackup.mutate(b.orgId)}>Back up now</button>{' '}
                      {b.days[0] && <button className="btn btn-outline cell-btn" onClick={() => setRehearse({ orgId: b.orgId, day: b.days[0]!, email: '' })}>Restore to new…</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="hint">No businesses yet.</p>}
          {rehearse && (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); restoreCopy.mutate(rehearse); }}>
              <div className="field"><label htmlFor="rb-day">Copy from</label><select id="rb-day" value={rehearse.day} onChange={(e) => setRehearse({ ...rehearse, day: e.target.value })}>{backups.data?.find((b) => b.orgId === rehearse.orgId)?.days.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
              <div className="field"><label htmlFor="rb-email">Admin email for the new business (optional)</label><input id="rb-email" type="email" value={rehearse.email} onChange={(e) => setRehearse({ ...rehearse, email: e.target.value })} /></div>
              <button className="btn btn-primary" disabled={restoreCopy.isPending}>Create restored business</button>
              <button type="button" className="btn btn-outline" onClick={() => setRehearse(null)}>Cancel</button>
            </form>
          )}
        </section>)}

        {page === 'operations' && (
        <section className="admin-section" aria-labelledby="h-usage">
          <h2 id="h-usage">Usage against the free limits</h2>
          {usage.data ? (() => {
            const u = usage.data;
            const today = u.days.at(-1);
            const rows = Object.keys(u.limits) as (keyof UsageDay)[];
            const peak = Math.max(0, ...u.days.map((d) => d.requests));
            return (
              <>
                {u.warnings.length > 0 && <p className="banner banner-warn" role="status">Close to a limit today: {u.warnings.map((w) => `${w.label} (${Math.round(w.pct * 100)}%)`).join(', ')}.</p>}
                {today ? (
                  <ul className="list" aria-label="Today's usage">
                    {rows.map((k) => {
                      const used = today[k] as number;
                      const max = u.limits[k]!;
                      return <li key={k}><span style={{ flex: 1 }}><strong>{u.labels[k]}</strong><div className="time">{used.toLocaleString()} of {max.toLocaleString()} today ({Math.round((used / max) * 100)}%)</div><progress max={max} value={Math.min(used, max)} aria-label={`${u.labels[k]} used today`} style={{ width: '100%' }} /></span></li>;
                    })}
                    <li><span><strong>Slowest 1% of requests</strong><div className="time">{(today.cpuP99Us / 1000).toFixed(1)} ms of CPU (median {(today.cpuP50Us / 1000).toFixed(1)} ms; the free limit is {u.cpuLimitUs / 1000} ms per request)</div></span></li>
                    <li><span><strong>Errors today</strong><div className="time">{today.errors.toLocaleString()} of {today.requests.toLocaleString()} requests</div></span></li>
                  </ul>
                ) : <p className="hint">No traffic recorded yet today.</p>}
                <details>
                  <summary>Last 30 days</summary>
                  <table className="orders-table">
                    <caption className="sr-only">Daily usage, newest first</caption>
                    <thead><tr><th scope="col">Day</th><th scope="col">Requests</th><th scope="col">Errors</th><th scope="col">DB rows written</th><th scope="col">DB rows read</th><th scope="col">Queue ops</th></tr></thead>
                    <tbody>{[...u.days].reverse().map((d) => <tr key={d.date}><th scope="row">{d.date}</th><td>{d.requests.toLocaleString()}{peak && d.requests === peak ? ' (peak)' : ''}</td><td>{d.errors}</td><td>{d.d1RowsWritten.toLocaleString()}</td><td>{d.d1RowsRead.toLocaleString()}</td><td>{d.queueOps}</td></tr>)}</tbody>
                  </table>
                </details>
                <h3>Busiest businesses (last 24 hours)</h3>
                {u.businesses.length ? (
                  <table className="orders-table">
                    <caption className="sr-only">Requests per business</caption>
                    <thead><tr><th scope="col">Business</th><th scope="col">Requests</th><th scope="col">Errors</th><th scope="col">Products</th><th scope="col">People</th><th scope="col">Last active</th></tr></thead>
                    <tbody>{u.businesses.map((b) => <tr key={b.orgId}><th scope="row">{b.name}</th><td>{b.requests.toLocaleString()}</td><td>{b.errors}</td><td>{b.products ?? '—'}</td><td>{b.members}</td><td>{when(b.lastActivityAt)}</td></tr>)}</tbody>
                  </table>
                ) : <p className="hint">Per-business counting started with this release; numbers appear after some traffic.</p>}
              </>
            );
          })() : <p className="hint">{usage.isLoading ? 'Loading…' : (usage.error as ApiError)?.message ?? 'Could not load.'}</p>}
        </section>)}

        {page === 'notices' && (
        <section className="admin-section" aria-labelledby="h-notices">
          <h2 id="h-notices">Announcements and maintenance</h2>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); addAnn.mutate(); }}>
            <div className="field"><label htmlFor="an-msg">Notice</label><input id="an-msg" required maxLength={500} value={ann.message} onChange={(e) => setAnn({ ...ann, message: e.target.value })} /></div>
            <div className="field narrow"><label htmlFor="an-sev">Kind</label><select id="an-sev" value={ann.severity} onChange={(e) => setAnn({ ...ann, severity: e.target.value })}><option value="info">Information</option><option value="warning">Warning</option></select></div>
            <div className="field narrow"><label htmlFor="an-aud">Who sees it</label><select id="an-aud" value={ann.audience} onChange={(e) => setAnn({ ...ann, audience: e.target.value })}><option value="everyone">Everyone</option><option value="admins">Admins only</option><option value="org">One business</option></select></div>
            {ann.audience === 'org' && <div className="field"><label htmlFor="an-org">Business</label><select id="an-org" required value={ann.orgId} onChange={(e) => setAnn({ ...ann, orgId: e.target.value })}><option value="">Choose…</option>{orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
            <button className="btn btn-primary" disabled={addAnn.isPending}>Publish</button>
          </form>
          {anns.data?.filter((a) => !a.endedAt && (!a.endsAt || a.endsAt > new Date().toISOString())).length ? (
            <ul className="list" aria-label="Live announcements">
              {anns.data.filter((a) => !a.endedAt && (!a.endsAt || a.endsAt > new Date().toISOString())).map((a) => <li key={a.id}><span><strong>{a.message}</strong><div className="time">{a.severity} · {a.audience === 'org' ? orgs.data?.find((o) => o.id === a.orgId)?.name ?? 'one business' : a.audience}</div></span><button className="btn btn-outline cell-btn" onClick={() => endAnn.mutate(a.id)}>End</button></li>)}
            </ul>
          ) : null}
          <h3>Maintenance</h3>
          <p className="hint">While on, every change is refused with a clear message and reads keep working. You can still sign in and use this console.</p>
          {maint.data?.length ? (
            <ul className="list" aria-label="Maintenance switches">
              {maint.data.map((m) => <li key={m.id}><span><strong>{m.orgName ?? 'Whole platform'}</strong> is in maintenance<div className="time">since {when(m.startedAt)}{m.message ? ` · ${m.message}` : ''}</div></span><button className="btn btn-danger cell-btn" onClick={() => stopMnt.mutate(m.id)}>Turn off</button></li>)}
            </ul>
          ) : null}
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (confirm(mnt.orgId ? 'Stop all changes for this business?' : 'Stop all changes on the whole platform?')) startMnt.mutate(); }}>
            <div className="field"><label htmlFor="mn-org">Scope</label><select id="mn-org" value={mnt.orgId} onChange={(e) => setMnt({ ...mnt, orgId: e.target.value })}><option value="">Whole platform</option>{orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
            <div className="field"><label htmlFor="mn-msg">Message (optional)</label><input id="mn-msg" maxLength={300} value={mnt.message} onChange={(e) => setMnt({ ...mnt, message: e.target.value })} /></div>
            <button className="btn btn-danger" disabled={startMnt.isPending}>Turn maintenance on</button>
          </form>
        </section>)}

        {page === 'support' && (
        <section className="admin-section" aria-labelledby="h-support">
          <h2 id="h-support">Support</h2>
          {support.data?.length ? (
            <ul className="list">
              {support.data.map((g) => (
                <li key={g.id}>
                  <span><strong>{g.orgName}</strong>{g.note ? ` · ${g.note}` : ''}<div className="time">{g.mode === 'assist' ? 'Hands-on (can edit, never delete)' : 'Read-only'} · {g.includeCustomers ? 'customer details included' : 'no customer details'} · open until {when(g.expiresAt)} ({Math.max(1, Math.round((Date.parse(g.expiresAt) - Date.now()) / 60000))} min left)</div></span>
                  <button className="btn btn-primary" onClick={async () => {
                    const d = await api<OrgDetail>('GET', `/admin/orgs/${g.orgId}`);
                    setSupport({ orgId: g.orgId, grantId: g.id, orgName: g.orgName, currency: d.organization.currency, expiresAt: g.expiresAt, mode: g.mode });
                    nav(`/o/${g.orgId}/products`);
                  }}>Open</button>
                </li>
              ))}
            </ul>
          ) : <p className="hint">No business has opened a support window. When one does, it appears here.</p>}
        </section>)}

        {page === 'security' && (
        <section className="admin-section" aria-labelledby="h-alerts">
          <h2 id="h-alerts">Alerts</h2>
          {alerts.isError ? <p className="hint">Could not load alerts.</p> : !alerts.data ? <p className="hint">Loading…</p> : !alerts.data.length ? <p className="hint">No alerts. They appear here when the sign-in log shows something worth a look.</p> : (
            <ul className="list" aria-label="Security alerts">
              {alerts.data.map((a) => (
                <li key={a.id} className="alert-row">
                  <span>
                    <strong>{a.label}</strong> <span className={`pill ${a.severity === 'high' ? 'bad' : 'warn'}`}>{a.severity}</span> <span className="pill">{a.state}</span>
                    <div className="time">{a.who ?? 'unknown'} · seen {a.count} time{a.count === 1 ? '' : 's'} · last {when(a.lastAt)}{a.note ? ` · note: ${a.note}` : ''}</div>
                  </span>
                  {(a.state === 'open' || a.state === 'investigating') && (
                    <span className="alert-actions">
                      <label className="sr-only" htmlFor={`an-${a.id}`}>Note for this alert</label>
                      <input id={`an-${a.id}`} maxLength={500} placeholder="Note (optional)" value={alertNote[a.id] ?? ''} onChange={(e) => setAlertNote({ ...alertNote, [a.id]: e.target.value })} />
                      {a.state === 'open' && <button className="btn btn-outline" disabled={setAlert.isPending} onClick={() => setAlert.mutate({ id: a.id, state: 'investigating' })}>Investigate</button>}
                      <button className="btn btn-primary" disabled={setAlert.isPending} onClick={() => setAlert.mutate({ id: a.id, state: 'resolved' })}>Resolve</button>
                      <button className="btn btn-outline" disabled={setAlert.isPending} onClick={() => setAlert.mutate({ id: a.id, state: 'dismissed' })}>Dismiss</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {page === 'security' && (
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
        </section>)}

        {page === 'businesses' && (
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
              <p>The invitation was emailed to the admin. If it does not arrive (check spam), send them this link. It works once, for their email only, and expires in 7 days. They can also just sign in with that email.</p>
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Admin invitation link" />
              <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(link).then(() => toast({ kind: 'success', text: 'Link copied' }))}>Copy</button>
            </div>
          )}
        </section>)}

        {page === 'businesses' && (
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
              {orgDetail.data.organization.deleteAfter && (
                <p className="banner banner-warn" role="status">Scheduled for deletion on {when(orgDetail.data.organization.deleteAfter)}. <button className="btn btn-outline cell-btn" onClick={() => api('POST', `/admin/orgs/${orgDetail.data!.organization.id}/cancel-deletion`, { body: {} }).then(() => { qc.invalidateQueries({ queryKey: ['admin'] }); toast({ text: 'Deletion cancelled' }); }).catch((e) => toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not cancel.' }))}>Cancel deletion</button></p>
              )}
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
        </section>)}

        {page === 'people' && (
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
        </section>)}

        {page === 'activity' && (
        <section className="admin-section" aria-labelledby="h-audit">
          <h2 id="h-audit">Platform activity</h2>
          <p><a className="btn btn-outline" href="/api/v1/admin/audit?format=csv" download>Download everything as CSV</a></p>
          {!audit.data?.length ? <p className="hint">No platform actions yet.</p> : (
            <ul className="list">{audit.data.map((a) => <li key={a.id}><span><strong>{a.action}</strong><div className="time">{a.target}</div></span><span className="time">{when(a.createdAt)}</span></li>)}</ul>
          )}
        </section>)}
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
