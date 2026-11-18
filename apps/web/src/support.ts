/** The owner's open support window, kept for this browser tab only. Closing the tab forgets it. */
export interface SupportView { orgId: string; grantId: string; orgName: string; currency: string; expiresAt: string; mode: 'view' | 'assist'; impersonating?: boolean }
const KEY = 'shoplist.support';

export function getSupport(): SupportView | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as SupportView | null;
    return v && Date.parse(v.expiresAt) > Date.now() ? v : null;
  } catch { return null; }
}
export function setSupport(v: SupportView): void { try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } }
export function clearSupport(): void { try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } }
