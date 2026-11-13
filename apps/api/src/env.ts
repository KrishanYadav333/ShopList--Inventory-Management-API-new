import type { InventoryDO } from './inventory-do';

export interface Bindings {
  DB: D1Database;
  INVENTORY: DurableObjectNamespace<InventoryDO>;
  /** Public origin of the app, e.g. https://shoplist.example.com. Used for OAuth redirects and the CSRF origin check. */
  APP_ORIGIN: string;
  /** GitHub numeric user id of the one super admin. Matched against the linked GitHub account, never an email. */
  SUPER_ADMIN_GITHUB_ID?: string;
  /** "admin-only" (default): only the super admin can sign in. "open": anyone with a verified GitHub email can. */
  SIGNIN_MODE?: string;
  /** "true" enables /auth/dev/login. Must never be set in production. */
  DEV_AUTH?: string;
  /** "true" (together with DEV_AUTH) drops the Secure/__Host- cookie so a browser can sign in over plain http://localhost. Local use only. */
  INSECURE_DEV_COOKIES?: string;
  /** Clerk: PEM public key (Dashboard > API keys > Show JWT public key), used to verify session tokens locally. */
  CLERK_JWT_KEY?: string;
  /** Clerk secret key, used once at sign-in to read the user's verified email. */
  CLERK_SECRET_KEY?: string;
  /** Clerk frontend API URL, e.g. https://example-12.clerk.accounts.dev. Must equal the token's `iss`. */
  CLERK_ISSUER?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Random 32+ byte secret used to sign the short-lived OAuth state cookie. */
  COOKIE_SIGNING_KEY?: string;
  /** Optional Workers rate limiting binding. */
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}
