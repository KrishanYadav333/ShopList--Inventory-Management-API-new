export function money(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
}

/** "12.5" -> 1250. Parses the decimal string directly; floats would round wrongly. */
export function toMinor(input: string): number | null {
  const m = input.trim().match(/^(\d{1,12})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

export const fromMinor = (minor: number | null | undefined): string => (minor == null ? '' : (minor / 100).toFixed(2));

export function dateParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

const COLORS = ['amazon', 'magento', 'ebay', 'shopify', 'woocommerce', 'phone'];
/** Stable avatar colour from the original dashboard palette. */
export function avatarClass(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Neutralises spreadsheet formula injection in exported cells. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export const REASON_LABELS: Record<string, string> = {
  receive: 'Received',
  sale: 'Sold',
  return: 'Returned',
  adjust: 'Adjusted',
  damage: 'Damaged',
  count: 'Counted',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  import: 'Imported',
};
