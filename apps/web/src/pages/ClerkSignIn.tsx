import { useEffect, useRef, useState } from 'react';
import { ClerkLoaded, ClerkLoading, ClerkProvider, SignIn, SignUp, useAuth } from '@clerk/react';
import { api, ApiError } from '../api';

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const ERROR_KEY = 'sl_signin_error';
const TRY_KEY = 'sl_bridge_try';
/** A failed attempt must never retry on its own: if Clerk still looks signed in right after one, stop and let the person choose. */
const RETRY_AFTER_MS = 20_000;

/** Where to go after sign-in. Only same-site invitation and organization paths, so this cannot become an open redirect. */
function returnPath(): string {
  try {
    const p = sessionStorage.getItem('sl_return');
    sessionStorage.removeItem('sl_return');
    if (p && /^\/(invite\/[A-Za-z0-9_-]+|o\/[A-Za-z0-9_-]+(\/[a-z]+)?)$/.test(p)) return p;
  } catch { /* storage unavailable */ }
  return '/';
}

/** A message left by a failed attempt. Reading is pure; it is removed in an effect, because React may render more than once before committing. */
function readError(): string {
  try { return sessionStorage.getItem(ERROR_KEY) ?? ''; } catch { return ''; }
}

/**
 * Clerk proves who the person is; ShopList owns the session. Once Clerk reports a signed-in user, trade its
 * short-lived token for a ShopList session cookie, then sign out of Clerk so there is only one session.
 * Clerk's sign-out is given the destination itself, so it is the only redirect and cannot race another.
 */
function Bridge() {
  const { isSignedIn, getToken, signOut } = useAuth();
  const started = useRef(false);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!isSignedIn || started.current) return;
    started.current = true;
    try {
      const last = Number(sessionStorage.getItem(TRY_KEY) ?? 0);
      if (Date.now() - last < RETRY_AFTER_MS) { setStuck(true); return; }
      sessionStorage.setItem(TRY_KEY, String(Date.now()));
    } catch { /* storage unavailable: fall through and try once */ }
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new ApiError({ status: 401, detail: 'Could not read your sign-in. Please try again.' });
        await api('POST', '/auth/clerk/session', { body: { token } });
        await signOut({ redirectUrl: returnPath() });
      } catch (e) {
        try { sessionStorage.setItem(ERROR_KEY, e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.'); } catch { /* storage unavailable */ }
        await signOut({ redirectUrl: '/sign-in' }); // lets them try another account, and brings the message back
      }
    })();
  }, [isSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  if (stuck) {
    return (
      <div role="status">
        <p className="hint">The last attempt did not finish. You are still signed in to the sign-in service, but ShopList did not accept this account.</p>
        <button className="btn btn-outline full" onClick={() => { try { sessionStorage.removeItem(TRY_KEY); } catch { /* ignore */ } void signOut({ redirectUrl: '/sign-in' }); }}>Use a different account</button>
      </div>
    );
  }
  return isSignedIn ? <p className="hint" role="status">Signing you in…</p> : null;
}

/**
 * While Clerk already holds a session, its own sign-in form redirects away at once, which bounced people straight
 * back to the login page. So the form is shown only when nobody is signed in; otherwise only the bridge is.
 */
function Gate() {
  const { isSignedIn } = useAuth();
  return isSignedIn ? <Bridge /> : <Widget />;
}

/** Path routing: /sign-in/... and /sign-up/... are real addresses, which is what Clerk's components expect. */
function Widget() {
  const looks = { elements: { rootBox: { width: '100%' }, card: { boxShadow: 'none', border: 0, width: '100%' } } };
  return location.pathname.startsWith('/sign-up')
    ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" appearance={looks} />
    : <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" appearance={looks} />;
}

export default function ClerkSignIn() {
  const [error] = useState(readError);
  useEffect(() => { try { sessionStorage.removeItem(ERROR_KEY); } catch { /* storage unavailable */ } }, []);
  if (!KEY) {
    return <main className="auth"><div className="auth-card"><h1>Client sign-in is not set up</h1><p>This deployment has no Clerk key configured.</p><a className="btn btn-outline full" href="/login">Back</a></div></main>;
  }
  return (
    <main className="auth">
      <div className="auth-card clerk-card">
        <img className="brand-lockup" src="/logo-lockup.png" alt="ShopList" width="280" height="83" />
        {error && <div className="notice" role="alert">{error}{/owner/i.test(error) && <> <a href="/owner">Go to the owner sign-in</a>.</>}</div>}
        {/* Finishing a sign-in or sign-up always lands on /sign-in, where the bridge trades the Clerk session for a ShopList one. Without this, Clerk sent people to "/" first and they had to click Sign in a second time. */}
        <ClerkProvider publishableKey={KEY} signInUrl="/sign-in" signUpUrl="/sign-up" signInForceRedirectUrl="/sign-in" signUpForceRedirectUrl="/sign-in" afterSignOutUrl="/sign-in">
          <ClerkLoading><p className="hint" role="status">Loading sign-in…</p></ClerkLoading>
          <ClerkLoaded>
            <Gate />
          </ClerkLoaded>
        </ClerkProvider>
        <a className="fine" href="/login">Back to the main sign-in</a>
      </div>
    </main>
  );
}
