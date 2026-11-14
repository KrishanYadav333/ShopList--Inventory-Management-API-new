import { useEffect, useRef, useState } from 'react';
import { ClerkLoaded, ClerkLoading, ClerkProvider, SignIn, useAuth } from '@clerk/react';
import { api, ApiError } from '../api';

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/** Where to go after sign-in. Only same-site invitation and organization paths, so this cannot become an open redirect. */
function returnPath(): string {
  try {
    const p = sessionStorage.getItem('sl_return');
    sessionStorage.removeItem('sl_return');
    if (p && /^\/(invite\/[A-Za-z0-9_-]+|o\/[A-Za-z0-9_-]+(\/[a-z]+)?)$/.test(p)) return p;
  } catch { /* storage unavailable */ }
  return '/';
}

/**
 * Clerk proves who the person is; ShopList owns the session. Once Clerk reports a signed-in user, trade its
 * short-lived token for a ShopList session cookie, then sign out of Clerk so there is only one session.
 */
function Bridge() {
  const { isSignedIn, getToken, signOut } = useAuth();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (!isSignedIn || started.current) return;
    started.current = true;
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new ApiError({ status: 401, detail: 'Could not read your sign-in. Please try again.' });
        await api('POST', '/auth/clerk/session', { body: { token } });
        await signOut();
        location.assign(returnPath());
      } catch (e) {
        await signOut().catch(() => undefined); // let them try another account
        setError(e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.');
        started.current = false;
      }
    })();
  }, [isSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="notice" role="alert">{error} <a href="/sign-in">Try again</a></div>;
  return isSignedIn ? <p className="hint" role="status">Signing you in…</p> : null;
}

export default function ClerkSignIn() {
  if (!KEY) {
    return <div className="auth"><div className="auth-card"><h1>Client sign-in is not set up</h1><p>This deployment has no Clerk key configured.</p><a className="btn btn-outline full" href="/login">Back</a></div></div>;
  }
  return (
    <div className="auth">
      <div className="auth-card clerk-card">
        <img className="brand-lockup" src="/logo-lockup.png" alt="ShopList" width="280" height="83" />
        <ClerkProvider publishableKey={KEY} afterSignOutUrl="/login">
          <ClerkLoading><p className="hint" role="status">Loading sign-in…</p></ClerkLoading>
          <ClerkLoaded>
            <Bridge />
            <SignIn routing="hash" signUpUrl="#/sign-up" appearance={{ elements: { rootBox: { width: '100%' }, card: { boxShadow: 'none', border: 0, width: '100%' } } }} />
          </ClerkLoaded>
        </ClerkProvider>
        <a className="fine" href="/login">Back to the main sign-in</a>
      </div>
    </div>
  );
}
