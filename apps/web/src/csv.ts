/** Parses CSV text (RFC 4180 quoting, BOM, CRLF, and comma / semicolon / tab delimiters) into rows of cells. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export type Field = 'sku' | 'name' | 'price' | 'cost' | 'barcode' | 'unit' | 'reorder' | 'tags' | 'description' | 'quantity';
export const FIELDS: { key: Field; label: string; required?: boolean; synonyms: string[] }[] = [
  { key: 'sku', label: 'SKU', required: true, synonyms: ['sku', 'itemcode', 'productcode', 'code', 'itemno', 'partnumber'] },
  { key: 'name', label: 'Name', required: true, synonyms: ['name', 'title', 'product', 'productname', 'itemname'] },
  { key: 'price', label: 'Price', required: true, synonyms: ['price', 'unitprice', 'sellingprice', 'retailprice', 'saleprice'] },
  { key: 'cost', label: 'Cost', synonyms: ['cost', 'costprice', 'unitcost', 'purchaseprice'] },
  { key: 'quantity', label: 'Quantity on hand', synonyms: ['quantity', 'qty', 'stock', 'onhand', 'instock', 'stocklevel'] },
  { key: 'barcode', label: 'Barcode', synonyms: ['barcode', 'ean', 'upc', 'gtin', 'ean13'] },
  { key: 'reorder', label: 'Reorder point', synonyms: ['reorderpoint', 'reorder', 'minstock', 'minimumstock', 'lowstock'] },
  { key: 'unit', label: 'Unit', synonyms: ['unit', 'uom', 'unitofmeasure'] },
  { key: 'tags', label: 'Tags', synonyms: ['tags', 'tag', 'category', 'categories', 'labels'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'desc', 'details', 'notes'] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Guesses which column holds which field from the header row. */
export function autoMap(headers: string[]): Record<Field, number> {
  const map = {} as Record<Field, number>;
  const used = new Set<number>();
  for (const f of FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && f.synonyms.includes(norm(h)));
    map[f.key] = idx;
    if (idx >= 0) used.add(idx);
  }
  return map;
}

export interface ParsedRow {
  line: number; // 1-based line in the file, header included
  raw: string[];
  row?: Record<string, unknown>;
  error?: string;
}

const money = (s: string): number | null => {
  const m = s.trim().replace(/^[^\d-]+/, '').replace(/\s/g, '').match(/^(\d{1,3}(?:[,.]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1].replace(/[,.]/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
};
const whole = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);

/** Turns mapped cells into API rows, with a plain-language error for anything that cannot be used. */
export function convertRows(data: string[][], map: Record<Field, number>): ParsedRow[] {
  const seen = new Map<string, number>();
  return data.map((raw, i) => {
    const line = i + 2;
    const cell = (f: Field) => (map[f] >= 0 ? (raw[map[f]] ?? '').trim() : '');
    const fail = (error: string): ParsedRow => ({ line, raw, error });
    const sku = cell('sku');
    if (!sku) return fail('SKU is empty');
    if (sku.length > 64) return fail('SKU is longer than 64 characters');
    if (seen.has(sku.toLowerCase())) return fail(`Duplicate of line ${seen.get(sku.toLowerCase())} (same SKU)`);
    seen.set(sku.toLowerCase(), line);
    const name = cell('name');
    if (!name) return fail('Name is empty');
    if (name.length > 200) return fail('Name is longer than 200 characters');
    const price = money(cell('price'));
    if (price === null) return fail(`Price “${cell('price')}” is not a number like 12.50`);
    const row: Record<string, unknown> = { sku, name, priceMinor: price };
    if (map.cost >= 0 && cell('cost') !== '') { const c = money(cell('cost')); if (c === null) return fail(`Cost “${cell('cost')}” is not a number like 7.25`); row.costMinor = c; }
    if (map.quantity >= 0 && cell('quantity') !== '') { const q = whole(cell('quantity')); if (q === null) return fail(`Quantity “${cell('quantity')}” must be a whole number`); row.quantity = q; }
    if (map.reorder >= 0 && cell('reorder') !== '') { const r = whole(cell('reorder')); if (r === null) return fail(`Reorder point “${cell('reorder')}” must be a whole number`); row.reorderPoint = r; }
    if (map.barcode >= 0 && cell('barcode') !== '') row.barcode = cell('barcode').slice(0, 64);
    if (map.unit >= 0 && cell('unit') !== '') row.unit = cell('unit').slice(0, 20);
    if (map.description >= 0 && cell('description') !== '') row.description = cell('description').slice(0, 5000);
    if (map.tags >= 0 && cell('tags') !== '') row.tags = cell('tags').split(/[,;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
    return { line, raw, row };
  });
}
