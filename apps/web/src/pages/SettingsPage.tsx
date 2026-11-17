import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_SCOPE_LABELS, PLAN_LIMIT_KEYS, PLAN_LIMIT_LABELS, ROLES, ROLE_LABELS, ROLE_SUMMARY, SETTINGS_DEFAULTS, WEBHOOK_EVENTS, type OrgSettings, type Role } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { Icon } from '../icons';
import { canAdmin, canDo, useLocations, useMe, usePlan } from '../queries';
import { useToast } from '../toast';
import { addPasskey, passkeysSupported, wasCancelled } from '../passkeys';

interface Member { id: string; name: string; email?: string; role: Role; deactivatedAt?: string | null; lastSeenAt?: string | null; locationIds?: string[] | null }
interface Pending { id: string; email: string; role: Role; createdAt: string; expiresAt: string; invitedBy: string | null }

export function SettingsPage() {
  const { org } = useShell();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const admin = canAdmin(org.role);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  const fail = (e: ApiError) => toast({ kind: 'error', text: e.message });

  const [name, setName] = useState(org.name);
  const rename = useMutation({ mutationFn: () => api('PATCH', `/orgs/${org.id}`, { body: { name } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); toast({ kind: 'success', text: 'Organization renamed' }); }, onError: fail });

  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ data: { id: string; name: string; created_at: string; last_used_at: string | null }[] }>('GET', '/auth/passkeys'), enabled: passkeysSupported() });
  const plan = usePlan(org.id);
  const feat = (k: 'apiKeys' | 'webhooks' | 'supportAccess') => plan.data?.features[k] !== false;
  const [sup, setSup] = useState({ minutes: 60, note: '', includeCustomers: false });
  interface Grant { id: string; note: string | null; includeCustomers: boolean; createdAt: string; expiresAt: string; endedAt: string | null; active: boolean; views: number; firstViewAt: string | null; lastViewAt: string | null }
  const grants = useQuery({ enabled: admin && plan.data?.features.supportAccess !== false, queryKey: ['org', org.id, 'support-grants'], queryFn: () => api<{ data: Grant[] }>('GET', `/orgs/${org.id}/support-grants`).then((r) => r.data) });
  const allow = useMutation({ mutationFn: () => api('POST', `/orgs/${org.id}/support-grants`, { body: { minutes: sup.minutes, note: sup.note.trim() || undefined, includeCustomers: sup.includeCustomers } }), onSuccess: () => { setSup({ ...sup, note: '' }); qc.invalidateQueries({ queryKey: ['org', org.id, 'support-grants'] }); toast({ kind: 'success', text: 'ShopList support can look until the time shown. You can end it any time.' }); }, onError: fail });
  const endGrant = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/support-grants/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['org', org.id, 'support-grants'] }); toast({ text: 'Support access ended' }); }, onError: fail });
  const [pkName, setPkName] = useState('');
  const addPk = useMutation({
    mutationFn: () => addPasskey(pkName.trim() || 'Passkey'),
    onSuccess: () => { setPkName(''); qc.invalidateQueries({ queryKey: ['passkeys'] }); toast({ kind: 'success', text: 'Passkey added' }); },
    onError: (e) => { if (!wasCancelled(e)) toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not add the passkey.' }); },
  });
  const removePk = useMutation({ mutationFn: (id: string) => api('DELETE', `/auth/passkeys/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['passkeys'] }); toast({ text: 'Passkey removed' }); }, onError: fail });

  interface Sess { id: string; current: boolean; lastSeenAt: string; userAgent: string | null; country: string | null; via: string }
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ data: Sess[] }>('GET', '/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => api('DELETE', `/auth/sessions/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); toast({ text: 'Signed out' }); }, onError: fail });
  const revokeOthers = useMutation({ mutationFn: () => api('POST', '/auth/sessions/revoke-others', { body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); toast({ text: 'Signed out everywhere else' }); }, onError: fail });
  interface AuthEv { at: string; kind: string; door: string | null; country: string | null; browser: string | null; reason: string | null }
  const events = useQuery({ queryKey: ['auth-events'], queryFn: () => api<{ data: AuthEv[] }>('GET', '/auth/events') });
  const notMe = useMutation({ mutationFn: () => api('POST', '/auth/not-me', { body: {} }), onSuccess: () => { qc.clear(); nav('/login'); }, onError: fail });
  const EVENT_LABEL: Record<string, string> = { signin_ok: 'Signed in', signin_refused: 'Sign-in refused', signout: 'Signed out', session_revoked: 'A session was ended', passkey_added: 'Passkey added', passkey_removed: 'Passkey removed', user_disabled: 'Account disabled', not_me: 'Reported “not me”' };
  const device = (ua: string | null) => (ua ? `${/iPhone|iPad|Android/.test(ua) ? 'Phone or tablet' : /Mac|Windows|Linux/.test(ua) ? 'Computer' : 'Device'} · ${/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'}` : 'Unknown device');

  const settingsQ = useQuery({ enabled: admin, queryKey: ['org', org.id, 'settings'], queryFn: () => api<{ settings: OrgSettings }>('GET', `/orgs/${org.id}/settings`).then((r) => r.settings) });
  const [form, setForm] = useState<OrgSettings | null>(null);
  const bs = form ?? settingsQ.data ?? SETTINGS_DEFAULTS;
  const setBs = (patch: Partial<OrgSettings>) => setForm({ ...bs, ...patch });
  const saveSettings = useMutation({
    mutationFn: () => api<{ settings: OrgSettings }>('PATCH', `/orgs/${org.id}/settings`, { body: { ...bs, email: bs.email ?? '' } }),
    onSuccess: (r) => { setForm(null); qc.setQueryData(['org', org.id, 'settings'], r.settings); qc.invalidateQueries({ queryKey: ['me'] }); toast({ kind: 'success', text: 'Business settings saved' }); },
    onError: fail,
  });
  const prefs = useQuery({ queryKey: ['notification-prefs', org.id], queryFn: () => api<{ data: { kind: string; label: string; inApp: boolean }[] }>('GET', `/me/notification-preferences?org=${org.id}`).then((r) => r.data) });
  const setPref = useMutation({ mutationFn: (v: { kind: string; inApp: boolean }) => api('PATCH', '/me/notification-preferences', { body: { orgId: org.id, ...v } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-prefs', org.id] }), onError: fail });
  const [backingUp, setBackingUp] = useState(false);
  /** Pages through every product and downloads one JSON file: a copy you control, and the input for a CSV re-import. */
  const backup = async () => {
    setBackingUp(true);
    try {
      const products: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await api<{ data: unknown[]; nextCursor?: string | null }>('GET', `/orgs/${org.id}/products?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        products.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const locs = await api<{ data: unknown[] }>('GET', `/orgs/${org.id}/locations`);
      const file = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), organization: { id: org.id, name: org.name, currency: org.currency }, locations: locs.data, products }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = `shoplist-backup-${org.name.replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ kind: 'success', text: `Backed up ${products.length} product${products.length === 1 ? '' : 's'}` });
    } catch (e) {
      toast({ kind: 'error', text: e instanceof ApiError ? e.message : 'Backup failed.' });
    } finally { setBackingUp(false); }
  };

  const locations = useLocations(org.id);
  const [loc, setLoc] = useState({ name: '', code: '' });
  const addLoc = useMutation({ mutationFn: () => api('POST', `/orgs/${org.id}/locations`, { body: loc }), onSuccess: () => { setLoc({ name: '', code: '' }); refresh(); toast({ kind: 'success', text: 'Location added' }); }, onError: fail });
  const archive = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/locations/${id}`), onSuccess: () => { refresh(); toast({ text: 'Location archived' }); }, onError: fail });

  const members = useQuery({ queryKey: ['org', org.id, 'members'], queryFn: () => api<{ data: Member[] }>('GET', `/orgs/${org.id}/members`).then((r) => r.data) });
  const setRole = useMutation({
    mutationFn: async (v: { id: string; role: Role }) => {
      try { return await api('PATCH', `/orgs/${org.id}/members/${v.id}`, { body: { role: v.role } }); } catch (e) {
        // An organization normally has one admin: ask before adding another.
        if (e instanceof ApiError && e.code === 'second-admin' && confirm('This organization already has an admin. Make this person an admin too?')) return api('PATCH', `/orgs/${org.id}/members/${v.id}`, { body: { role: v.role, confirmSecondAdmin: true } });
        throw e;
      }
    },
    onSuccess: refresh,
    onError: (e: ApiError) => { fail(e); refresh(); },
  });
  const pending = useQuery({ enabled: admin, queryKey: ['org', org.id, 'invitations'], queryFn: () => api<{ data: Pending[] }>('GET', `/orgs/${org.id}/invitations`).then((r) => r.data) });
  const refreshTeam = () => { qc.invalidateQueries({ queryKey: ['org', org.id, 'members'] }); qc.invalidateQueries({ queryKey: ['org', org.id, 'invitations'] }); };
  const resendInv = useMutation({ mutationFn: (id: string) => api<{ link: string }>('POST', `/orgs/${org.id}/invitations/${id}/resend`, { body: {} }), onSuccess: (r) => { setLink(r.link); refreshTeam(); toast({ kind: 'success', text: 'New link created' }); }, onError: fail });
  const revokeInv = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/invitations/${id}`), onSuccess: () => { refreshTeam(); toast({ text: 'Invitation revoked' }); }, onError: fail });
  const setActive = useMutation({ mutationFn: (v: { id: string; on: boolean }) => api('POST', `/orgs/${org.id}/members/${v.id}/${v.on ? 'reactivate' : 'deactivate'}`, { body: {} }), onSuccess: (_r, v) => { refreshTeam(); toast({ text: v.on ? 'Member reactivated' : 'Member deactivated' }); }, onError: fail });
  const handover = useMutation({ mutationFn: (v: { userId: string; confirmName: string }) => api('POST', `/orgs/${org.id}/admin-handover`, { body: v }), onSuccess: () => { qc.invalidateQueries(); toast({ kind: 'success', text: 'Admin role handed over' }); }, onError: fail });
  const setScope = useMutation({ mutationFn: (v: { id: string; locationIds: string[] | null }) => api('PATCH', `/orgs/${org.id}/members/${v.id}`, { body: { locationIds: v.locationIds } }), onSuccess: () => { refreshTeam(); toast({ text: 'Locations updated' }); }, onError: fail });
  const removeMember = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/members/${id}`), onSuccess: () => { refresh(); toast({ text: 'Member removed' }); }, onError: fail });
  const [invite, setInvite] = useState({ email: '', role: 'manager' });
  const [link, setLink] = useState('');
  const sendInvite = useMutation({
    mutationFn: async () => {
      try { return await api<{ link: string }>('POST', `/orgs/${org.id}/invitations`, { body: invite }); } catch (e) {
        if (e instanceof ApiError && e.code === 'second-admin' && confirm('This organization already has an admin. Invite another admin?')) return api<{ link: string }>('POST', `/orgs/${org.id}/invitations`, { body: { ...invite, confirmSecondAdmin: true } });
        throw e;
      }
    },
    onSuccess: (r) => { setLink(r.link); setInvite({ email: '', role: 'manager' }); },
    onError: fail,
  });

  interface ApiKeyRow { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }
  const keys = useQuery({ enabled: admin, queryKey: ['org', org.id, 'api-keys'], queryFn: () => api<{ data: ApiKeyRow[] }>('GET', `/orgs/${org.id}/api-keys`).then((r) => r.data) });
  const [keyForm, setKeyForm] = useState<{ name: string; scopes: string[]; days: string }>({ name: '', scopes: [], days: '' });
  const [newKey, setNewKey] = useState('');
  const makeKey = useMutation({
    mutationFn: () => api<{ key: string }>('POST', `/orgs/${org.id}/api-keys`, { body: { name: keyForm.name, scopes: ['inventory:read', ...keyForm.scopes], expiresInDays: keyForm.days ? Number(keyForm.days) : null } }),
    onSuccess: (r) => { setNewKey(r.key); setKeyForm({ name: '', scopes: [], days: '' }); refresh(); },
    onError: fail,
  });
  const revokeKey = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/api-keys/${id}`), onSuccess: () => { refresh(); toast({ text: 'API key revoked' }); }, onError: fail });

  interface HookRow { id: string; url: string; events: string[]; active: boolean; secretPrefix: string; lastStatus: string | null; lastDeliveryAt: string | null }
  interface DeliveryRow { id: string; eventType: string; status: string; httpStatus: number | null; attempts: number; createdAt: string }
  const hooks = useQuery({ enabled: admin, queryKey: ['org', org.id, 'webhooks'], queryFn: () => api<{ data: HookRow[] }>('GET', `/orgs/${org.id}/webhooks`).then((r) => r.data) });
  const [hookForm, setHookForm] = useState<{ url: string; all: boolean; events: string[] }>({ url: '', all: true, events: [] });
  const [newSecret, setNewSecret] = useState('');
  const [openHook, setOpenHook] = useState<string | null>(null);
  const deliveries = useQuery({ enabled: admin && !!openHook, queryKey: ['org', org.id, 'webhooks', openHook, 'deliveries'], queryFn: () => api<{ data: DeliveryRow[] }>('GET', `/orgs/${org.id}/webhooks/${openHook}/deliveries`).then((r) => r.data) });
  const addHook = useMutation({
    mutationFn: () => api<{ secret: string }>('POST', `/orgs/${org.id}/webhooks`, { body: { url: hookForm.url.trim(), events: hookForm.all ? ['*'] : hookForm.events } }),
    onSuccess: (r) => { setNewSecret(r.secret); setHookForm({ url: '', all: true, events: [] }); refresh(); },
    onError: fail,
  });
  const delHook = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/webhooks/${id}`), onSuccess: () => { refresh(); toast({ text: 'Webhook deleted' }); }, onError: fail });
  const testHook = useMutation({ mutationFn: (id: string) => api('POST', `/orgs/${org.id}/webhooks/${id}/test`, { body: {} }), onSuccess: () => { toast({ kind: 'success', text: 'Test event sent. Check the history in a few seconds.' }); setTimeout(() => qc.invalidateQueries({ queryKey: ['org', org.id, 'webhooks'] }), 4000); }, onError: fail });

  const audit = useQuery({ enabled: admin, queryKey: ['org', org.id, 'audit'], queryFn: () => api<{ data: { id: string; action: string; entity: string; changes: unknown; actor: string; createdAt: string }[] }>('GET', `/orgs/${org.id}/audit?limit=25`).then((r) => r.data) });
  const [confirmName, setConfirmName] = useState('');
  const [exp, setExp] = useState({ from: '', to: '' });
  const del = useMutation({ mutationFn: () => api<{ deleteAfter: string }>('DELETE', `/orgs/${org.id}`, { body: { confirmName } }), onSuccess: () => { setConfirmName(''); qc.invalidateQueries({ queryKey: ['me'] }); toast({ text: 'Deletion scheduled. You have 14 days to change your mind.' }); }, onError: fail });
  const cancelDel = useMutation({ mutationFn: () => api('POST', `/orgs/${org.id}/cancel-deletion`, { body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); toast({ text: 'Deletion cancelled' }); }, onError: fail });

  const submit = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };

  return (
    <>
      <header className="top-header"><div className="breadcrumb"><span>Inventory</span><Icon name="chevron" size={12} /><h1 className="current">Settings</h1></div></header>
      <div className="settings">
        <section className="card">
          <h2>Organization</h2>
          <form className="inline-form" onSubmit={submit(() => rename.mutate())}>
            <div className="field"><label htmlFor="s-name">Name</label><input id="s-name" value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} maxLength={100} /></div>
            {admin && <button className="btn btn-primary" disabled={rename.isPending || !name.trim() || name === org.name}>Save</button>}
          </form>
          <p className="hint">Your role: <strong>{org.role}</strong></p>
        </section>

        <section className="card">
          <h2>Locations</h2>
          <ul className="list">
            {locations.data?.filter((l) => !l.archivedAt).map((l) => (
              <li key={l.id}><span><strong>{l.name}</strong> <span className="tag">{l.code}</span>{l.isDefault && <span className="tag tag-blue">default</span>}</span>
                {admin && !l.isDefault && <button className="btn btn-outline" onClick={() => archive.mutate(l.id)}>Archive</button>}</li>
            ))}
          </ul>
          {admin && (
            <form className="inline-form" onSubmit={submit(() => addLoc.mutate())}>
              <div className="field"><label htmlFor="l-name">New location</label><input id="l-name" placeholder="e.g. Downtown shop" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} maxLength={100} /></div>
              <div className="field narrow"><label htmlFor="l-code">Code</label><input id="l-code" placeholder="SHOP" value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value })} maxLength={20} /></div>
              <button className="btn btn-primary" disabled={addLoc.isPending || !loc.name.trim() || !loc.code.trim()}>Add</button>
            </form>
          )}
        </section>

        <section className="card">
          <h2>Members</h2>
          <ul className="list">
            {members.data?.map((m) => (
              <li key={m.id}>
                <span><strong>{m.name}</strong>{m.deactivatedAt && <span className="tag">deactivated</span>}{m.email && <div className="time">{m.email}{m.lastSeenAt ? ` · last seen ${dateParts(m.lastSeenAt).date}` : ''}</div>}</span>
                <span className="row">
                  {admin && m.id !== me.data?.user.id ? (
                    <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as Role })}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  ) : <span className="tag">{ROLE_LABELS[m.role] ?? m.role}</span>}
                  {admin && m.id !== me.data?.user.id && m.role !== 'admin' && (locations.data?.length ?? 0) > 1 && (
                    <details className="scope">
                      <summary>{m.locationIds ? `${m.locationIds.length} location${m.locationIds.length === 1 ? '' : 's'}` : 'All locations'}</summary>
                      <div className="scope-menu">
                        <label className="check"><input type="checkbox" checked={!m.locationIds} onChange={() => setScope.mutate({ id: m.id, locationIds: m.locationIds ? null : [] })} /> All locations</label>
                        {m.locationIds && locations.data?.map((l) => (
                          <label className="check" key={l.id}><input type="checkbox" checked={m.locationIds!.includes(l.id)} onChange={(e) => setScope.mutate({ id: m.id, locationIds: e.target.checked ? [...m.locationIds!, l.id] : m.locationIds!.filter((x) => x !== l.id) })} /> {l.name}</label>
                        ))}
                        {m.locationIds && <p className="hint">Can see every location; can change stock and orders only at the ticked ones.</p>}
                      </div>
                    </details>
                  )}
                  {admin && m.id !== me.data?.user.id && (m.deactivatedAt
                    ? <button className="btn btn-outline" onClick={() => setActive.mutate({ id: m.id, on: true })}>Reactivate</button>
                    : <button className="btn btn-outline" onClick={() => { if (confirm(`Deactivate ${m.name}? They lose access now. Their history stays.`)) setActive.mutate({ id: m.id, on: false }); }}>Deactivate</button>)}
                  {admin && m.id !== me.data?.user.id && <button className="btn btn-outline" onClick={() => { if (confirm(`Remove ${m.name} completely? Deactivate keeps their history.`)) removeMember.mutate(m.id); }}>Remove</button>}
                  {admin && m.id !== me.data?.user.id && !m.deactivatedAt && m.role !== 'admin' && <button className="btn btn-outline" onClick={() => { const t = prompt(`Hand over ${org.name} to ${m.name}? You become a manager. Type the business name to confirm:`); if (t !== null) handover.mutate({ userId: m.id, confirmName: t }); }}>Make admin</button>}
                </span>
              </li>
            ))}
          </ul>
          {admin && (
            <>
            <form className="inline-form" onSubmit={submit(() => sendInvite.mutate())}>
              <div className="field"><label htmlFor="i-email">Invite by email</label><input id="i-email" type="email" placeholder="teammate@example.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></div>
              <div className="field narrow"><label htmlFor="i-role">Role</label>
                <select id="i-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
              <button className="btn btn-primary" disabled={sendInvite.isPending || !invite.email}>Create link</button>
            </form>
            <ul className="hint role-help">
              {ROLES.map((r) => <li key={r}><strong>{ROLE_LABELS[r]}</strong>: {ROLE_SUMMARY[r]}</li>)}
            </ul>
            <p className="hint">The person signs in with that email (Google or email code) and lands in this organization with the role you chose. The link is optional.</p>
            {pending.data && pending.data.length > 0 && (
              <>
                <h3>Pending invitations</h3>
                <ul className="list">
                  {pending.data.map((i) => (
                    <li key={i.id}>
                      <span><strong>{i.email}</strong> <span className="tag">{ROLE_LABELS[i.role] ?? i.role}</span><div className="time">invited by {i.invitedBy ?? 'the platform owner'} · expires {dateParts(i.expiresAt).date}</div></span>
                      <span className="row">
                        <button className="btn btn-outline" onClick={() => resendInv.mutate(i.id)}>New link</button>
                        <button className="btn btn-outline" onClick={() => revokeInv.mutate(i.id)}>Revoke</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            </>
          )}
          {link && (
            <div className="invite-link" role="status">
              <p>Send this link to them. It works once, for that email address only, and expires in 7 days.</p>
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
              <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(link).then(() => toast({ kind: 'success', text: 'Link copied' }))}>Copy</button>
            </div>
          )}
        </section>

        {admin && plan.data?.usage && (
          <section className="card" aria-labelledby="h-plan">
            <h2 id="h-plan">Plan: {plan.data.plan.name}</h2>
            <p className="hint">What your business uses, against what your plan allows. Need more? Ask the ShopList owner.</p>
            <ul className="list">
              {PLAN_LIMIT_KEYS.map((k) => {
                const max = plan.data!.limits[k];
                const used = plan.data!.usage![k];
                const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
                return (
                  <li key={k}>
                    <span style={{ flex: 1 }}>
                      <strong>{PLAN_LIMIT_LABELS[k]}</strong>
                      <div className="time">{used.toLocaleString()} of {max === undefined || max === null ? 'no limit' : max.toLocaleString()}{max && pct >= 80 ? ' · nearly full' : ''}</div>
                      {max ? <progress max={max} value={Math.min(used, max)} aria-label={`${PLAN_LIMIT_LABELS[k]} used`} style={{ width: '100%' }} /> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {admin && feat('supportAccess') && (
          <section className="card" aria-labelledby="h-support">
            <h2 id="h-support">Support access</h2>
            <p className="hint">Stuck? Let the ShopList owner look at your business for a short time. They can only read, never change anything, and cannot see your team or settings. Every page they open is logged here and in your activity log. You can end it at any time.</p>
            {grants.data?.find((g) => g.active) ? (() => {
              const g = grants.data!.find((x) => x.active)!;
              return (
                <div role="status">
                  <p><strong>Support access is on</strong> until {dateParts(g.expiresAt).time}{g.includeCustomers ? ' (customer details included)' : ''}. {g.views} page{g.views === 1 ? '' : 's'} viewed so far.</p>
                  <button className="btn btn-danger" disabled={endGrant.isPending} onClick={() => endGrant.mutate(g.id)}>End now</button>
                </div>
              );
            })() : (
              <form className="settings-grid" onSubmit={submit(() => allow.mutate())}>
                <div className="field"><label htmlFor="sup-min">For how long</label>
                  <select id="sup-min" value={sup.minutes} onChange={(e) => setSup({ ...sup, minutes: Number(e.target.value) })}><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={240}>4 hours</option></select></div>
                <div className="field"><label htmlFor="sup-note">What is the problem? (optional)</label><input id="sup-note" maxLength={300} value={sup.note} onChange={(e) => setSup({ ...sup, note: e.target.value })} /></div>
                <label className="check"><input type="checkbox" checked={sup.includeCustomers} onChange={(e) => setSup({ ...sup, includeCustomers: e.target.checked })} /> Include customer names, emails and phone numbers</label>
                <button className="btn btn-primary" disabled={allow.isPending}>Allow ShopList support</button>
              </form>
            )}
            {grants.data?.filter((g) => !g.active).length ? (
              <ul className="list" aria-label="Past support access">
                {grants.data.filter((g) => !g.active).slice(0, 5).map((g) => (
                  <li key={g.id}><span><strong>{dateParts(g.createdAt).date} {dateParts(g.createdAt).time}</strong>{g.note ? ` · ${g.note}` : ''}<div className="time">{g.views ? `ShopList support viewed ${g.views} page${g.views === 1 ? '' : 's'} between ${dateParts(g.firstViewAt!).time} and ${dateParts(g.lastViewAt!).time}.` : 'Nobody looked.'}</div></span></li>
                ))}
              </ul>
            ) : null}
          </section>
        )}

        {admin && feat('apiKeys') && (
          <section className="card" aria-labelledby="h-keys">
            <h2 id="h-keys">API keys</h2>
            <p className="hint">For other systems, such as a web shop or a scanner. A key belongs to this organization only and can read or write inventory, nothing else. Send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
            {keys.data?.length ? (
              <ul className="list">
                {keys.data.map((k) => (
                  <li key={k.id}>
                    <span><strong>{k.name}</strong> <span className="tag">{k.prefix}…</span><span className="tag">{k.scopes.filter((x) => x !== 'inventory:read').length ? k.scopes.filter((x) => x !== 'inventory:read').map((x) => (x === 'inventory:write' ? 'write all' : x.replace(':write', '').replace(':read', ''))).join(', ') : 'read only'}</span>{k.revokedAt && <span className="tag">revoked</span>}
                      <div className="time">Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}</div></span>
                    {!k.revokedAt && <button className="btn btn-outline" onClick={() => { if (confirm(`Revoke ${k.name}? Anything using it stops working immediately.`)) revokeKey.mutate(k.id); }}>Revoke</button>}
                  </li>
                ))}
              </ul>
            ) : <p className="hint">No keys yet.</p>}
            <form className="inline-form" onSubmit={submit(() => makeKey.mutate())}>
              <div className="field"><label htmlFor="k-name">New key name</label><input id="k-name" placeholder="e.g. Shopify connector" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} maxLength={60} /></div>
              <div className="field narrow"><label htmlFor="k-days">Expires in (days)</label><input id="k-days" inputMode="numeric" placeholder="never" value={keyForm.days} onChange={(e) => setKeyForm({ ...keyForm, days: e.target.value.replace(/\D/g, '') })} /></div>
              <fieldset className="modes" style={{ gridColumn: '1 / -1' }}>
                <legend>What this key may do (it can always read products, stock and orders)</legend>
                {(['products:write', 'stock:write', 'orders:write', 'reports:read', 'cost:read'] as const).map((sc) => (
                  <label className="check" key={sc}><input type="checkbox" checked={keyForm.scopes.includes(sc)} onChange={(e) => setKeyForm({ ...keyForm, scopes: e.target.checked ? [...keyForm.scopes, sc] : keyForm.scopes.filter((x) => x !== sc) })} /> {API_KEY_SCOPE_LABELS[sc]}</label>
                ))}
              </fieldset>
              <button className="btn btn-primary" disabled={makeKey.isPending || !keyForm.name.trim()}>Create key</button>
            </form>
            {newKey && (
              <div className="invite-link" role="status">
                <p><strong>Copy this key now.</strong> It is shown only once and cannot be recovered; if you lose it, revoke it and make a new one.</p>
                <input readOnly value={newKey} onFocus={(e) => e.target.select()} aria-label="New API key" />
                <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(newKey).then(() => toast({ kind: 'success', text: 'Key copied' }))}>Copy</button>
                <button className="btn btn-outline" onClick={() => setNewKey('')}>I have saved it</button>
              </div>
            )}
          </section>
        )}

        {admin && feat('webhooks') && (
          <section className="card" aria-labelledby="h-hooks">
            <h2 id="h-hooks">Webhooks</h2>
            <p className="hint">ShopList sends a signed POST to your address when something happens. Each request carries <code>ShopList-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code>timestamp.body</code> with your signing secret. Failed deliveries are retried for about a day.</p>
            {hooks.data?.length ? (
              <ul className="list">
                {hooks.data.map((h) => (
                  <li key={h.id} className="stack">
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ overflowWrap: 'anywhere' }}>{h.url}</strong>
                      <div>{h.events.map((e) => <span key={e} className="tag">{e === '*' ? 'all events' : e}</span>)}</div>
                      <div className="time">{h.lastStatus ? `Last delivery: ${h.lastStatus}${h.lastDeliveryAt ? ' · ' + new Date(h.lastDeliveryAt).toLocaleString() : ''}` : 'No deliveries yet'} · secret {h.secretPrefix}…</div>
                    </span>
                    <span className="row">
                      <button className="btn btn-outline" onClick={() => testHook.mutate(h.id)}>Send test</button>
                      <button className="btn btn-outline" aria-expanded={openHook === h.id} onClick={() => setOpenHook(openHook === h.id ? null : h.id)}>History</button>
                      <button className="btn btn-outline" onClick={() => { if (confirm('Delete this webhook?')) delHook.mutate(h.id); }}>Delete</button>
                    </span>
                    {openHook === h.id && (
                      <div className="deliveries">
                        {!deliveries.data?.length ? <p className="hint">Nothing recorded yet.</p> : (
                          <table className="diff"><thead><tr><th>When</th><th>Event</th><th>Result</th><th className="num">Tries</th></tr></thead>
                            <tbody>{deliveries.data.map((d) => <tr key={d.id}><td>{new Date(d.createdAt).toLocaleString()}</td><td>{d.eventType}</td><td>{d.status === 'delivered' ? `Delivered (${d.httpStatus})` : `Failed${d.httpStatus ? ` (${d.httpStatus})` : ' (no response)'}`}</td><td className="num">{d.attempts}</td></tr>)}</tbody></table>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="hint">No webhooks yet.</p>}
            <form className="hook-form" onSubmit={submit(() => addHook.mutate())}>
              <div className="field"><label htmlFor="w-url">Destination URL (https)</label><input id="w-url" type="url" placeholder="https://example.com/shoplist-events" value={hookForm.url} onChange={(e) => setHookForm({ ...hookForm, url: e.target.value })} /></div>
              <fieldset className="modes">
                <legend>Events</legend>
                <label className="check"><input type="checkbox" checked={hookForm.all} onChange={(e) => setHookForm({ ...hookForm, all: e.target.checked })} /> All events</label>
                {!hookForm.all && <div className="event-grid">{WEBHOOK_EVENTS.map((ev) => <label key={ev} className="check"><input type="checkbox" checked={hookForm.events.includes(ev)} onChange={(e) => setHookForm({ ...hookForm, events: e.target.checked ? [...hookForm.events, ev] : hookForm.events.filter((x) => x !== ev) })} /> {ev}</label>)}</div>}
              </fieldset>
              <button className="btn btn-primary" disabled={addHook.isPending || !hookForm.url.trim() || (!hookForm.all && !hookForm.events.length)}>Add webhook</button>
            </form>
            {newSecret && (
              <div className="invite-link" role="status">
                <p><strong>Copy the signing secret now.</strong> It is shown only once. Use it to verify the signature on each request.</p>
                <input readOnly value={newSecret} onFocus={(e) => e.target.select()} aria-label="Signing secret" />
                <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(newSecret).then(() => toast({ kind: 'success', text: 'Secret copied' }))}>Copy</button>
                <button className="btn btn-outline" onClick={() => setNewSecret('')}>I have saved it</button>
              </div>
            )}
          </section>
        )}

        {admin && (
          <section className="card">
            <h2>Business</h2>
            <p className="hint">Used on invoices, orders and reports.</p>
            <form className="settings-grid" onSubmit={submit(() => saveSettings.mutate())}>
              <div className="field"><label htmlFor="b-legal">Legal name</label><input id="b-legal" maxLength={120} value={bs.legalName ?? ''} onChange={(e) => setBs({ legalName: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-tax-id">Tax id (GSTIN, VAT no.)</label><input id="b-tax-id" maxLength={40} value={bs.taxId ?? ''} onChange={(e) => setBs({ taxId: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-addr">Address</label><input id="b-addr" maxLength={300} value={bs.address ?? ''} onChange={(e) => setBs({ address: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-phone">Phone</label><input id="b-phone" maxLength={40} value={bs.phone ?? ''} onChange={(e) => setBs({ phone: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-email">Business email</label><input id="b-email" type="email" value={bs.email ?? ''} onChange={(e) => setBs({ email: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-cur">Currency</label><input id="b-cur" maxLength={3} value={bs.currency} onChange={(e) => setBs({ currency: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label htmlFor="b-taxmode">Tax</label>
                <select id="b-taxmode" value={bs.taxMode} onChange={(e) => setBs({ taxMode: e.target.value as OrgSettings['taxMode'] })}><option value="none">No tax</option><option value="inclusive">Prices include tax</option><option value="exclusive">Tax added on top</option></select></div>
              <div className="field"><label htmlFor="b-taxrate">Tax rate (%)</label><input id="b-taxrate" type="number" min={0} max={100} step="0.01" value={bs.taxRateBp / 100} onChange={(e) => setBs({ taxRateBp: Math.round(Number(e.target.value) * 100) })} /></div>
              <div className="field"><label htmlFor="b-tz">Timezone</label><input id="b-tz" value={bs.timezone} onChange={(e) => setBs({ timezone: e.target.value })} placeholder="e.g. Asia/Kathmandu" /></div>
              <div className="field"><label htmlFor="b-op">Order number prefix</label><input id="b-op" maxLength={8} value={bs.orderPrefix} onChange={(e) => setBs({ orderPrefix: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-rp">Default reorder point</label><input id="b-rp" type="number" min={0} value={bs.defaultReorderPoint ?? ''} onChange={(e) => setBs({ defaultReorderPoint: e.target.value === '' ? null : Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="b-ret">Keep the activity log for</label>
                <select id="b-ret" value={bs.auditRetentionYears} onChange={(e) => setBs({ auditRetentionYears: Number(e.target.value) })}>{[1, 2, 3, 5, 7].map((y) => <option key={y} value={y}>{y} year{y === 1 ? '' : 's'}</option>)}</select></div>
              <fieldset className="modes approvals-rules" style={{ gridColumn: '1 / -1' }}>
                <legend>Approvals (a manager must agree before these happen)</legend>
                <p className="hint">Managers and the admin are never asked. Everyone else’s request waits in Approvals.</p>
                <label className="check"><input type="checkbox" checked={bs.approvals.damage.on} onChange={(e) => setBs({ approvals: { ...bs.approvals, damage: { on: e.target.checked } } })} /> Damage write-offs</label>
                <label className="check"><input type="checkbox" checked={bs.approvals.largeAdjustment.on} onChange={(e) => setBs({ approvals: { ...bs.approvals, largeAdjustment: { ...bs.approvals.largeAdjustment, on: e.target.checked } } })} /> Large stock reductions: more than <input aria-label="Units" className="mini" type="number" min={1} value={bs.approvals.largeAdjustment.units} onChange={(e) => setBs({ approvals: { ...bs.approvals, largeAdjustment: { ...bs.approvals.largeAdjustment, units: Number(e.target.value) || 1 } } })} /> units or worth more than <input aria-label="Value" className="mini" type="number" min={0} value={bs.approvals.largeAdjustment.valueMinor / 100} onChange={(e) => setBs({ approvals: { ...bs.approvals, largeAdjustment: { ...bs.approvals.largeAdjustment, valueMinor: Math.round(Number(e.target.value) * 100) } } })} /></label>
                <label className="check"><input type="checkbox" checked={bs.approvals.countVariance.on} onChange={(e) => setBs({ approvals: { ...bs.approvals, countVariance: { ...bs.approvals.countVariance, on: e.target.checked } } })} /> Stock counts that differ by more than <input aria-label="Count units" className="mini" type="number" min={1} value={bs.approvals.countVariance.units} onChange={(e) => setBs({ approvals: { ...bs.approvals, countVariance: { ...bs.approvals.countVariance, units: Number(e.target.value) || 1 } } })} /> units</label>
                <label className="check"><input type="checkbox" checked={bs.approvals.cancelPaid.on} onChange={(e) => setBs({ approvals: { ...bs.approvals, cancelPaid: { on: e.target.checked } } })} /> Cancelling an order that is already paid</label>
                <label className="check"><input type="checkbox" checked={bs.approvals.priceDrop.on} onChange={(e) => setBs({ approvals: { ...bs.approvals, priceDrop: { ...bs.approvals.priceDrop, on: e.target.checked } } })} /> Price drops of more than <input aria-label="Percent" className="mini" type="number" min={1} max={100} value={bs.approvals.priceDrop.percent} onChange={(e) => setBs({ approvals: { ...bs.approvals, priceDrop: { ...bs.approvals.priceDrop, percent: Math.min(100, Math.max(1, Number(e.target.value) || 1)) } } })} /> %</label>
              </fieldset>
              <button className="btn btn-primary" disabled={saveSettings.isPending || !form}>{saveSettings.isPending ? 'Saving…' : 'Save business settings'}</button>
            </form>
          </section>
        )}

        <section className="card">
          <h2>Notifications</h2>
          <p className="hint">Choose what shows up under the bell. Only events relevant to your role are sent.</p>
          <div className="modes">
            {prefs.data?.map((k) => <label className="check" key={k.kind}><input type="checkbox" checked={k.inApp} onChange={(e) => setPref.mutate({ kind: k.kind, inApp: e.target.checked })} /> {k.label}</label>)}
          </div>
        </section>

        <section className="card">
          <h2>Where you are signed in</h2>
          {sessions.data?.data.length ? (
            <ul className="list">
              {sessions.data.data.map((x) => (
                <li key={x.id}>
                  <span><strong>{device(x.userAgent)}{x.current ? ' (this device)' : ''}</strong><div className="time">{x.country ? `${x.country} · ` : ''}last active {dateParts(x.lastSeenAt).date} {dateParts(x.lastSeenAt).time}</div></span>
                  {!x.current && <button className="btn btn-outline" onClick={() => revoke.mutate(x.id)} aria-label={`Sign out ${device(x.userAgent)}`}>Sign out</button>}
                </li>
              ))}
            </ul>
          ) : <p className="hint">Loading…</p>}
          {(sessions.data?.data.length ?? 0) > 1 && <button className="btn btn-outline" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out everywhere else</button>}
        </section>

        <section className="card">
          <h2>Recent sign-in activity</h2>
          {events.data?.data.length ? (
            <ul className="list">
              {events.data.data.map((e, i) => (
                <li key={i}><span><strong>{EVENT_LABEL[e.kind] ?? e.kind}</strong>{e.door ? ` · ${e.door}` : ''}<div className="time">{[e.browser, e.country].filter(Boolean).join(' · ')}{e.browser || e.country ? ' · ' : ''}{dateParts(e.at).date} {dateParts(e.at).time}</div></span></li>
              ))}
            </ul>
          ) : <p className="hint">{events.isLoading ? 'Loading…' : 'Nothing recorded yet.'}</p>}
          <p className="hint">See something you do not recognise? This signs you out everywhere and tells your admin.</p>
          <button className="btn btn-danger" disabled={notMe.isPending} onClick={() => { if (window.confirm('Sign out everywhere and tell your admin that a sign-in was not you?')) notMe.mutate(); }}>This wasn’t me</button>
        </section>

        {passkeysSupported() && (
          <section className="card">
            <h2>Passkeys</h2>
            <p className="hint">Sign in with your fingerprint, face or device PIN instead of an email code. Passkeys sign you in as a normal user; the owner’s admin access always needs GitHub.</p>
            {passkeys.data?.data.length ? (
              <ul className="list">
                {passkeys.data.data.map((k) => (
                  <li key={k.id}>
                    <span><strong>{k.name}</strong><div className="time">Added {dateParts(k.created_at).date}{k.last_used_at ? ` · last used ${dateParts(k.last_used_at).date}` : ' · never used'}</div></span>
                    <button className="btn btn-outline" onClick={() => { if (confirm(`Remove passkey “${k.name}”?`)) removePk.mutate(k.id); }} aria-label={`Remove passkey ${k.name}`}>Remove</button>
                  </li>
                ))}
              </ul>
            ) : <p className="hint">No passkeys yet.</p>}
            <form className="hook-form" onSubmit={submit(() => addPk.mutate())}>
              <div className="field"><label htmlFor="pk-name">Name</label><input id="pk-name" maxLength={60} placeholder="e.g. MacBook Touch ID" value={pkName} onChange={(e) => setPkName(e.target.value)} /></div>
              <button className="btn btn-primary" disabled={addPk.isPending}>{addPk.isPending ? 'Waiting for your device…' : 'Add a passkey'}</button>
            </form>
          </section>
        )}

        {admin && (
          <section className="card">
            <h2>Activity log</h2>
            {!audit.data?.length ? <p className="hint">No activity yet.</p> : (
              <ul className="list">
                {audit.data.map((a) => { const { date, time } = dateParts(a.createdAt); return <li key={a.id}><span><strong>{a.action}</strong><div className="time">{JSON.stringify(a.changes ?? {}).slice(0, 120)}</div></span><span className="time">{date} {time}</span></li>; })}
              </ul>
            )}
          </section>
        )}

        {(admin || canDo(org.role, 'audit:read')) && (
          <section className="card" aria-labelledby="h-export">
            <h2 id="h-export">Export the activity log</h2>
            <p className="hint">Who did what and when, as a spreadsheet file. Up to 5,000 rows per file; choose a shorter range for more.</p>
            <div className="settings-grid">
              <div className="field"><label htmlFor="ex-from">From</label><input id="ex-from" type="date" value={exp.from} onChange={(e) => setExp({ ...exp, from: e.target.value })} /></div>
              <div className="field"><label htmlFor="ex-to">To</label><input id="ex-to" type="date" value={exp.to} onChange={(e) => setExp({ ...exp, to: e.target.value })} /></div>
            </div>
            <a className="btn btn-outline" href={`/api/v1/orgs/${org.id}/audit?format=csv${exp.from ? `&from=${exp.from}` : ''}${exp.to ? `&to=${exp.to}` : ''}`} download>Download CSV</a>
          </section>
        )}

        {admin && (
          <section className="card">
            <h2>Backup</h2>
            <p className="hint">Download every product and location as one JSON file. Keep it somewhere safe before big changes. To restore, export products to CSV from the Products page and use Import.</p>
            <button className="btn btn-outline" onClick={backup} disabled={backingUp}>{backingUp ? 'Preparing…' : 'Download backup (JSON)'}</button>
          </section>
        )}

        {org.role === 'admin' && (
          <section className="card danger">
            <h2>Danger zone</h2>
            {org.deleteAfter ? (
              <>
                <p><strong>{org.name} will be deleted on {dateParts(org.deleteAfter).date}.</strong> Until then it is read-only. Everything is removed for good after that.</p>
                <button className="btn btn-outline" disabled={cancelDel.isPending} onClick={() => cancelDel.mutate()}>Cancel deletion</button>
              </>
            ) : (
              <form onSubmit={submit(() => del.mutate())}>
                <p>Deleting the organization removes all its products, stock, orders and team after <strong>14 days</strong>. Until then it is read-only and you can cancel. Download a backup first (above).</p>
                <div className="field"><label htmlFor="del-name">Type <strong>{org.name}</strong> to confirm</label><input id="del-name" autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} /></div>
                <button className="btn btn-danger" disabled={confirmName.trim() !== org.name || del.isPending}>Delete organization in 14 days</button>
              </form>
            )}
          </section>
        )}
      </div>
    </>
  );
}
