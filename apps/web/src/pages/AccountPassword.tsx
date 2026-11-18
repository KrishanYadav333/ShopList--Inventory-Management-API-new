import { ClerkLoaded, ClerkLoading, ClerkProvider, SignIn, UserProfile, useAuth } from '@clerk/react';
import { NavLink } from 'react-router-dom';

const KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/**
 * Set or change the password for signing in. The sign-in service owns passwords, so this page opens its own
 * account screen. If the person signed up with Google or an emailed code they have no password yet, and this is
 * where they add one. It does not hand a session to ShopList; it only edits the sign-in account.
 */
function Inner() {
  const { isSignedIn } = useAuth();
  if (!isSignedIn) {
    return (
      <>
        <p className="hint">Sign in once more to prove it is you, then you can set a password. Use the same email you use for ShopList.</p>
        <SignIn routing="hash" forceRedirectUrl="/account/password" signUpUrl="/sign-up" />
      </>
    );
  }
  return (
    <>
      <p className="hint">Open <strong>Security</strong>, then <strong>Set password</strong> (or <strong>Update password</strong>).</p>
      <UserProfile routing="hash" />
      {/* The sign-in page hands this Clerk session to ShopList (and ends the Clerk one), so this works whether or not ShopList was signed in before. */}
      <a className="btn btn-primary full" href="/sign-in">Done, continue to ShopList</a>
    </>
  );
}

export default function AccountPassword() {
  if (!KEY) return <main className="auth"><div className="auth-card"><h1>Not set up</h1><p>This deployment has no sign-in service key.</p></div></main>;
  return (
    <main className="auth">
      <div className="auth-card clerk-card">
        <h1>Password</h1>
        <ClerkProvider publishableKey={KEY} afterSignOutUrl="/">
          <ClerkLoading><p className="hint" role="status">Loading…</p></ClerkLoading>
          <ClerkLoaded><Inner /></ClerkLoaded>
        </ClerkProvider>
        <NavLink className="fine" to="/">Back to ShopList without changing anything</NavLink>
      </div>
    </main>
  );
}
