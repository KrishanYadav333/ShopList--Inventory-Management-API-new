import type { InventoryDO } from './inventory-do';

export interface Bindings {
  DB: D1Database;
  INVENTORY: DurableObjectNamespace<InventoryDO>;
  /** Public origin of the app, e.g. https://shoplist.example.com. Used for OAuth redirects and the CSRF origin check. */
  APP_ORIGIN: string;
  /** "true" enables /auth/dev/login. Must never be set in production. */
  DEV_AUTH?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Random 32+ byte secret used to sign the short-lived OAuth state cookie. */
  COOKIE_SIGNING_KEY?: string;
  /** Optional Workers rate limiting binding. */
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}
