import type { Bindings } from './env';
import { AppError } from './errors';

/**
 * Clerk is used only to prove who someone is at sign-in. The Worker verifies Clerk's signed session
 * token itself (no SDK, no network call for the signature), then issues ShopList's own session.
 */

const b64urlToBytes = (s: string): Uint8Array => {
  const p = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const decodeJson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;

const LEEWAY_S = 5;
const invalid = () => new AppError(401, 'invalid_token', 'Your sign-in could not be verified. Please try again.');

export const clerkConfigured = (env: Bindings): boolean => !!(env.CLERK_JWT_KEY && env.CLERK_SECRET_KEY && env.CLERK_ISSUER);

async function publicKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return crypto.subtle.importKey('spki', b64urlToBytes(body.replaceAll('+', '-').replaceAll('/', '_')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/** Verifies an RS256 Clerk session token and returns the Clerk user id (`sub`). Throws 401 on anything off. */
export async function verifyClerkToken(env: Bindings, token: string, now = Date.now()): Promise<string> {
  if (!clerkConfigured(env)) throw new AppError(503, 'clerk_not_configured', 'Sign-in is not configured on this server.');
  if (typeof token !== 'string' || token.length > 4096) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  let header: { alg?: string }, claims: { sub?: string; iss?: string; exp?: number; nbf?: number; azp?: string };
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw invalid();
  }
  // Pin the algorithm: never trust the token's own header to choose "none" or a symmetric alg.
  if (header.alg !== 'RS256') throw invalid();
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await publicKey(env.CLERK_JWT_KEY!), b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    throw invalid();
  }
  if (!ok) throw invalid();
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < nowS) throw invalid();
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > nowS) throw invalid();
  if (claims.iss !== env.CLERK_ISSUER) throw invalid();
  // azp is the origin that requested the token; it must be this app, which blocks tokens minted for other sites.
  if (claims.azp !== undefined && claims.azp !== new URL(env.APP_ORIGIN).origin) throw invalid();
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('user_')) throw invalid();
  return claims.sub;
}

export interface ClerkProfile {
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** One call at sign-in to read the user's primary email and whether Clerk has verified it. */
export async function fetchClerkProfile(env: Bindings, sub: string): Promise<ClerkProfile> {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(sub)}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, accept: 'application/json' } });
  if (!res.ok) throw new AppError(502, 'clerk_unavailable', 'Sign-in is temporarily unavailable. Please try again.');
  const u = (await res.json()) as {
    banned?: boolean;
    locked?: boolean;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    image_url?: string | null;
    primary_email_address_id?: string | null;
    email_addresses?: { id: string; email_address: string; verification?: { status?: string } | null }[];
  };
  if (u.banned || u.locked) throw new AppError(403, 'account_disabled', 'This account has been disabled.');
  const primary = u.email_addresses?.find((e) => e.id === u.primary_email_address_id);
  if (!primary || primary.verification?.status !== 'verified') {
    throw new AppError(403, 'email_not_verified', 'Verify your email address with the sign-in provider, then try again.');
  }
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || primary.email_address.split('@')[0];
  return { email: primary.email_address, name, avatarUrl: u.image_url ?? null };
}
