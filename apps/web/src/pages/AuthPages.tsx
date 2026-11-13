import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { Icon } from '../icons';
import { useMe } from '../queries';
import { useToast } from '../toast';

export function Login() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ signin: 'open' | 'owner-only' }>('GET', '/health'), staleTime: 300_000 });
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const dev = useMutation({
    mutationFn: () => api('POST', '/auth/dev/login', { body: { email } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); nav('/'); },
    onError: (e: ApiError) => setError(e.message),
  });
  if (me.data) return <Navigate to="/" replace />;
  const submit = (e: FormEvent) => { e.preventDefault(); setError(''); dev.mutate(); };
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="logo-icon big">SL</div>
        <h1>Sign in to ShopList</h1>
        <p>Inventory you can trust: every change is recorded.</p>
        {health.data?.signin === 'owner-only' && <p className="notice" role="note">This ShopList is private. Only the site owner can sign in.</p>}
        <a className="btn btn-github" href="/api/v1/auth/oauth/github"><Icon name="github" size={18} /> Continue with GitHub</a>
        {import.meta.env.DEV && (
          <form onSubmit={submit} className="dev-login">
            <div className="hint">Development only</div>
            <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email for development sign-in" />
            <button className="btn btn-outline" disabled={dev.isPending}>Dev sign-in</button>
          </form>
        )}
        {error && <div className="field-error" role="alert">{error}</div>}
        <p className="fine">We never see or store a password. Sign-in is handled by GitHub.</p>
      </div>
    </div>
  );
}

/** Lands after sign-in: pick the first organization, or offer to create one. */
export function Home() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ organization: { id: string } }>('POST', '/orgs', { body: { name } }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['me'] }); nav(`/o/${r.organization.id}/products`); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });
  if (me.isLoading) return <div className="boot">Loading…</div>;
  if (me.isError || !me.data) return <Navigate to="/login" replace />;
  const orgs = me.data.organizations;
  if (orgs.length && !location.search.includes('new')) return <Navigate to={`/o/${orgs[0].id}/products`} replace />;
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="logo-icon big">SL</div>
        <h1>{orgs.length ? 'New organization' : `Welcome, ${me.data.user.name.split(' ')[0]}`}</h1>
        <p>An organization holds one business’s products, locations and team.</p>
        <div className="field"><label htmlFor="o-name">Organization name</label><input id="o-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Acme Hardware" /></div>
        <button className="btn btn-primary full" disabled={!name.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create organization'}</button>
        {orgs.length > 0 && <button type="button" className="btn btn-outline full" onClick={() => nav(`/o/${orgs[0].id}/products`)}>Cancel</button>}
      </form>
    </div>
  );
}

export function Invite() {
  const { token = '' } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api<{ organizationId: string }>('POST', `/invitations/${token}/accept`, { body: {} }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['me'] }); nav(`/o/${r.organizationId}/products`); },
  });
  if (me.isLoading) return <div className="boot">Loading…</div>;
  if (!me.data) return <Navigate to="/login" replace />;
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="logo-icon big">SL</div>
        <h1>You’ve been invited</h1>
        <p>Join as <strong>{me.data.user.email}</strong>. The invitation only works for this email address.</p>
        <button className="btn btn-primary full" onClick={() => accept.mutate()} disabled={accept.isPending}>{accept.isPending ? 'Joining…' : 'Accept invitation'}</button>
        {accept.error && <div className="field-error" role="alert">{(accept.error as ApiError).message}</div>}
      </div>
    </div>
  );
}
