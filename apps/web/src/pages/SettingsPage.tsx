import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, WEBHOOK_EVENTS, type Role } from '@shoplist/shared';
import { api, ApiError } from '../api';
import { useShell } from '../components/Shell';
import { dateParts } from '../format';
import { Icon } from '../icons';
import { canAdmin, useLocations, useMe } from '../queries';
import { useToast } from '../toast';

interface Member { id: string; name: string; email: string; role: Role }

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

  const locations = useLocations(org.id);
  const [loc, setLoc] = useState({ name: '', code: '' });
  const addLoc = useMutation({ mutationFn: () => api('POST', `/orgs/${org.id}/locations`, { body: loc }), onSuccess: () => { setLoc({ name: '', code: '' }); refresh(); toast({ kind: 'success', text: 'Location added' }); }, onError: fail });
  const archive = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/locations/${id}`), onSuccess: () => { refresh(); toast({ text: 'Location archived' }); }, onError: fail });

  const members = useQuery({ queryKey: ['org', org.id, 'members'], queryFn: () => api<{ data: Member[] }>('GET', `/orgs/${org.id}/members`).then((r) => r.data) });
  const setRole = useMutation({ mutationFn: (v: { id: string; role: Role }) => api('PATCH', `/orgs/${org.id}/members/${v.id}`, { body: { role: v.role } }), onSuccess: refresh, onError: (e: ApiError) => { fail(e); refresh(); } });
  const removeMember = useMutation({ mutationFn: (id: string) => api('DELETE', `/orgs/${org.id}/members/${id}`), onSuccess: () => { refresh(); toast({ text: 'Member removed' }); }, onError: fail });
  const [invite, setInvite] = useState({ email: '', role: 'editor' });
  const [link, setLink] = useState('');
  const sendInvite = useMutation({
    mutationFn: () => api<{ link: string }>('POST', `/orgs/${org.id}/invitations`, { body: invite }),
    onSuccess: (r) => { setLink(r.link); setInvite({ email: '', role: 'editor' }); },
    onError: fail,
  });

  interface ApiKeyRow { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }
  const keys = useQuery({ enabled: admin, queryKey: ['org', org.id, 'api-keys'], queryFn: () => api<{ data: ApiKeyRow[] }>('GET', `/orgs/${org.id}/api-keys`).then((r) => r.data) });
  const [keyForm, setKeyForm] = useState({ name: '', write: false, days: '' });
  const [newKey, setNewKey] = useState('');
  const makeKey = useMutation({
    mutationFn: () => api<{ key: string }>('POST', `/orgs/${org.id}/api-keys`, { body: { name: keyForm.name, scopes: keyForm.write ? ['inventory:read', 'inventory:write'] : ['inventory:read'], expiresInDays: keyForm.days ? Number(keyForm.days) : null } }),
    onSuccess: (r) => { setNewKey(r.key); setKeyForm({ name: '', write: false, days: '' }); refresh(); },
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
  const del = useMutation({ mutationFn: () => api('DELETE', `/orgs/${org.id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); nav('/'); }, onError: fail });

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
                <span><strong>{m.name}</strong><div className="time">{m.email}</div></span>
                <span className="row">
                  {admin && m.id !== me.data?.user.id ? (
                    <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as Role })}>
                      {ROLES.filter((r) => org.role === 'owner' || r !== 'owner').map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : <span className="tag">{m.role}</span>}
                  {admin && m.id !== me.data?.user.id && <button className="btn btn-outline" onClick={() => removeMember.mutate(m.id)}>Remove</button>}
                </span>
              </li>
            ))}
          </ul>
          {admin && (
            <form className="inline-form" onSubmit={submit(() => sendInvite.mutate())}>
              <div className="field"><label htmlFor="i-email">Invite by email</label><input id="i-email" type="email" placeholder="teammate@example.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></div>
              <div className="field narrow"><label htmlFor="i-role">Role</label>
                <select id="i-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}><option value="viewer">viewer</option><option value="editor">editor</option><option value="admin">admin</option></select></div>
              <button className="btn btn-primary" disabled={sendInvite.isPending || !invite.email}>Create link</button>
            </form>
          )}
          {link && (
            <div className="invite-link" role="status">
              <p>Send this link to them. It works once, for that email address only, and expires in 7 days.</p>
              <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
              <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(link).then(() => toast({ kind: 'success', text: 'Link copied' }))}>Copy</button>
            </div>
          )}
        </section>

        {admin && (
          <section className="card" aria-labelledby="h-keys">
            <h2 id="h-keys">API keys</h2>
            <p className="hint">For other systems, such as a web shop or a scanner. A key belongs to this organization only and can read or write inventory, nothing else. Send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
            {keys.data?.length ? (
              <ul className="list">
                {keys.data.map((k) => (
                  <li key={k.id}>
                    <span><strong>{k.name}</strong> <span className="tag">{k.prefix}…</span><span className="tag">{k.scopes.includes('inventory:write') ? 'read + write' : 'read only'}</span>{k.revokedAt && <span className="tag">revoked</span>}
                      <div className="time">Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}</div></span>
                    {!k.revokedAt && <button className="btn btn-outline" onClick={() => { if (confirm(`Revoke ${k.name}? Anything using it stops working immediately.`)) revokeKey.mutate(k.id); }}>Revoke</button>}
                  </li>
                ))}
              </ul>
            ) : <p className="hint">No keys yet.</p>}
            <form className="inline-form" onSubmit={submit(() => makeKey.mutate())}>
              <div className="field"><label htmlFor="k-name">New key name</label><input id="k-name" placeholder="e.g. Shopify connector" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} maxLength={60} /></div>
              <div className="field narrow"><label htmlFor="k-days">Expires in (days)</label><input id="k-days" inputMode="numeric" placeholder="never" value={keyForm.days} onChange={(e) => setKeyForm({ ...keyForm, days: e.target.value.replace(/\D/g, '') })} /></div>
              <label className="check"><input type="checkbox" checked={keyForm.write} onChange={(e) => setKeyForm({ ...keyForm, write: e.target.checked })} /> Allow writing</label>
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

        {admin && (
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
            <h2>Activity log</h2>
            {!audit.data?.length ? <p className="hint">No activity yet.</p> : (
              <ul className="list">
                {audit.data.map((a) => { const { date, time } = dateParts(a.createdAt); return <li key={a.id}><span><strong>{a.action}</strong><div className="time">{JSON.stringify(a.changes ?? {}).slice(0, 120)}</div></span><span className="time">{date} {time}</span></li>; })}
              </ul>
            )}
          </section>
        )}

        {org.role === 'owner' && (
          <section className="card danger">
            <h2>Danger zone</h2>
            <p>Deleting the organization hides it and all its data from everyone.</p>
            <button className="btn btn-danger" onClick={() => { if (confirm(`Delete ${org.name}? This hides all its data.`)) del.mutate(); }}>Delete organization</button>
          </section>
        )}
      </div>
    </>
  );
}
