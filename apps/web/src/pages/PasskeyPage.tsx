import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { addPasskey, confirmWithPasskey, passkeysSupported, wasCancelled } from '../passkeys';
import { useMe } from '../queries';

interface Status { enforced: boolean; applies: 'owner' | 'admin' | null; hasPasskey: boolean; verified: boolean; graceUntil: string | null; optionalOwner: boolean }

/** Where the owner and business admins add a passkey (this device or a phone, by QR code) or tap one to continue. */
export default function PasskeyPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const next = params.get('next');
  const to = next && /^\/(o\/|admin|account|$)/.test(next) ? next : me.data?.user.isSuperAdmin ? '/admin' : '/';
  const status = useQuery({ queryKey: ['passkey-status'], queryFn: () => api<Status>('GET', '/auth/passkey-status') });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const done = () => { void qc.invalidateQueries(); location.assign(to); };
  const fail = (e: unknown) => { if (!wasCancelled(e)) setError(e instanceof ApiError ? e.message : 'That did not work. Please try again.'); };
  const add = useMutation({ mutationFn: (where: 'device' | 'phone') => addPasskey(name.trim() || (where === 'phone' ? 'My phone' : 'This device'), where), onSuccess: done, onError: fail });
  const tap = useMutation({ mutationFn: confirmWithPasskey, onSuccess: done, onError: fail });

  if (me.isLoading || status.isLoading) return <div className="boot">Loading…</div>;
  if (!me.data) return <Navigate to="/login" replace />;
  const s = status.data;
  if (!s) return <main className="auth"><div className="auth-card"><h1>Passkey</h1><p role="alert">Could not load. Try again.</p></div></main>;
  if (!passkeysSupported()) {
    return <main className="auth"><div className="auth-card"><h1>Passkey</h1><p>This browser cannot use passkeys. Open ShopList in a current version of Chrome, Safari, Edge or Firefox.</p></div></main>;
  }
  const grace = s.graceUntil && Date.parse(s.graceUntil) > Date.now() ? new Date(s.graceUntil).toLocaleDateString() : null;
  return (
    <main className="auth">
      <div className="auth-card">
        <img className="brand-mark-lg" src="/logo-symbol.png" alt="ShopList" width="56" height="60" />
        {s.hasPasskey && !s.verified ? (
          <>
            <h1>Confirm it is you</h1>
            <p>Use your fingerprint, face or device PIN. If your passkey is on your phone, choose the phone option and scan the QR code your browser shows.</p>
            <button className="btn btn-primary full" disabled={tap.isPending} onClick={() => { setError(''); tap.mutate(); }}>{tap.isPending ? 'Waiting for your passkey…' : 'Confirm with my passkey'}</button>
          </>
        ) : (
          <>
            <h1>{s.hasPasskey ? 'Add another passkey' : 'Add a passkey'}</h1>
            <p>{s.applies === 'owner' ? 'The owner account needs a passkey.' : s.applies === 'admin' ? 'Business admins need a passkey.' : 'A passkey lets you sign in with your fingerprint, face or device PIN.'}{grace ? ` You can add it any time until ${grace}.` : ''}</p>
            <div className="field"><label htmlFor="pk">Name (optional)</label><input id="pk" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My phone" /></div>
            <button className="btn btn-primary full" disabled={add.isPending} onClick={() => { setError(''); add.mutate('phone'); }}>{add.isPending ? 'Waiting…' : 'Add a passkey on my phone (scan a QR code)'}</button>
            <button className="btn btn-outline full" disabled={add.isPending} onClick={() => { setError(''); add.mutate('device'); }}>Add a passkey on this device</button>
            <p className="fine">Tip: add two, for example your phone and your computer, so losing one never locks you out.</p>
            {s.hasPasskey && s.verified && <a className="fine" href={to}>Continue</a>}
            {!s.enforced || grace ? <a className="fine" href={to}>Not now</a> : null}
          </>
        )}
        {error && <div className="notice" role="alert">{error}</div>}
      </div>
    </main>
  );
}
