import { DurableObject } from 'cloudflare:workers';
import {
  LIMITS,
  type CountInput,
  type Dashboard,
  type Location,
  type LocationInput,
  type Movement,
  type MovementInput,
  type MovementListQuery,
  type ImportResult,
  type ImportRow,
  type MovementReason,
  type Order,
  type OrderCounts,
  type OrderInput,
  type OrderListQuery,
  type OrderState,
  type Page,
  type Product,
  type ProductInput,
  type ProductListQuery,
  type ProductPatch,
  type StockLevel,
  type TransferInput,
} from '@shoplist/shared';
import type { Bindings } from './env';
import { ok, type Problem, type Result } from './errors';
import { decodeCursor, encodeCursor, newId, nowIso } from './util';

// ---------------------------------------------------------------------------
// Schema. Append new steps; never edit an applied one. Each step runs once, in
// one transaction, the first time the object wakes after a deploy.
// ---------------------------------------------------------------------------
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE locations (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       code TEXT NOT NULL UNIQUE,
       is_default INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       archived_at TEXT
     )`,
    `CREATE TABLE products (
       id TEXT PRIMARY KEY,
       sku TEXT NOT NULL,
       name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
       description TEXT CHECK (length(description) <= 5000),
       barcode TEXT,
       unit TEXT NOT NULL DEFAULT 'each',
       price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
       cost_minor INTEGER CHECK (cost_minor >= 0),
       reorder_point INTEGER CHECK (reorder_point >= 0),
       on_hand_total INTEGER NOT NULL DEFAULT 0,
       attention INTEGER NOT NULL DEFAULT 1,
       version INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       deleted_at TEXT
     )`,
    `CREATE UNIQUE INDEX products_sku ON products(sku) WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL`,
    `CREATE INDEX products_updated ON products(updated_at, id)`,
    `CREATE INDEX products_name ON products(name COLLATE NOCASE, id)`,
    `CREATE INDEX products_attention ON products(on_hand_total, id) WHERE attention = 1 AND deleted_at IS NULL`,
    `CREATE TABLE product_tags (
       product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
       tag TEXT NOT NULL,
       PRIMARY KEY (product_id, tag)
     )`,
    `CREATE INDEX product_tags_tag ON product_tags(tag, product_id)`,
    `CREATE VIRTUAL TABLE products_fts USING fts5(
       product_id UNINDEXED, name, sku, barcode, description,
       tokenize = 'unicode61 remove_diacritics 2'
     )`,
    `CREATE TABLE stock_levels (
       product_id TEXT NOT NULL REFERENCES products(id),
       location_id TEXT NOT NULL REFERENCES locations(id),
       on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
       reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
       updated_at TEXT NOT NULL,
       PRIMARY KEY (product_id, location_id)
     )`,
    `CREATE TABLE stock_movements (
       id TEXT PRIMARY KEY,
       product_id TEXT NOT NULL,
       location_id TEXT NOT NULL,
       delta INTEGER NOT NULL CHECK (delta <> 0),
       reason TEXT NOT NULL,
       reference TEXT,
       note TEXT CHECK (length(note) <= 500),
       balance INTEGER NOT NULL,
       actor TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX movements_product ON stock_movements(product_id, created_at DESC)`,
    `CREATE INDEX movements_created ON stock_movements(created_at DESC, id DESC)`,
    `CREATE TABLE audit_log (
       id TEXT PRIMARY KEY,
       actor TEXT NOT NULL,
       action TEXT NOT NULL,
       entity TEXT NOT NULL,
       entity_id TEXT NOT NULL,
       changes TEXT,
       request_id TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX audit_created ON audit_log(created_at DESC, id DESC)`,
    `CREATE INDEX audit_entity ON audit_log(entity, entity_id, created_at DESC)`,
    `CREATE TABLE idempotency_keys (
       key TEXT PRIMARY KEY,
       request_hash TEXT NOT NULL,
       status INTEGER NOT NULL,
       response TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    `INSERT INTO counters(name, value) VALUES ('products', 0), ('low_stock', 0), ('out_of_stock', 0), ('inventory_value_minor', 0)`,
  ],
  // Step 2: orders. An order reserves stock when created; shipping turns the reservation into a sale.
  [
    `CREATE TABLE orders (
       id TEXT PRIMARY KEY,
       number TEXT NOT NULL UNIQUE,
       channel TEXT NOT NULL DEFAULT 'manual',
       customer_name TEXT NOT NULL,
       customer_email TEXT,
       country TEXT,
       note TEXT,
       location_id TEXT NOT NULL REFERENCES locations(id),
       paid INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL CHECK (state IN ('payment_required', 'waiting_for_stock', 'ready_to_ship', 'shipped', 'cancelled')),
       version INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       shipped_at TEXT
     )`,
    `CREATE INDEX orders_state ON orders(state, created_at DESC, id DESC)`,
    `CREATE INDEX orders_created ON orders(created_at DESC, id DESC)`,
    `CREATE INDEX orders_customer ON orders(customer_name COLLATE NOCASE)`,
    `CREATE TABLE order_lines (
       id TEXT PRIMARY KEY,
       order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
       product_id TEXT NOT NULL REFERENCES products(id),
       quantity INTEGER NOT NULL CHECK (quantity > 0),
       reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= quantity),
       unit_price_minor INTEGER NOT NULL,
       sku TEXT NOT NULL,
       name TEXT NOT NULL,
       open INTEGER NOT NULL DEFAULT 1
     )`,
    `CREATE INDEX order_lines_order ON order_lines(order_id)`,
    `CREATE INDEX order_lines_waiting ON order_lines(product_id) WHERE open = 1 AND reserved < quantity`,
    `INSERT INTO counters(name, value) VALUES ('order_seq', 1000)`,
  ],
];

// ---------------------------------------------------------------------------
type Row = Record<string, SqlStorageValue>;
type Extra = Pick<Problem, 'errors' | 'current'>;

/** Thrown inside a transaction to roll it back and report a business failure. */
class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly extra?: Extra,
  ) {
    super(detail);
  }
}

export interface Caller {
  actor: string;
  requestId: string;
}
export interface Idem {
  key: string;
  hash: string;
}
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: any;
  requestId: string;
  createdAt: string;
}
export interface Out<T> {
  status: number;
  body: T;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  unit: string;
  price_minor: number;
  cost_minor: number | null;
  reorder_point: number | null;
  on_hand_total: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface OrderRow {
  id: string;
  number: string;
  channel: string;
  customer_name: string;
  customer_email: string | null;
  country: string | null;
  note: string | null;
  location_id: string;
  paid: number;
  state: OrderState;
  version: number;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
}
interface LineRow {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  reserved: number;
  unit_price_minor: number;
  sku: string;
  name: string;
}

/** What the customer-facing state of an open order is, from payment and how much stock is held. */
const openState = (paid: boolean, lines: { quantity: number; reserved: number }[]): OrderState =>
  !paid ? 'payment_required' : lines.some((l) => l.reserved < l.quantity) ? 'waiting_for_stock' : 'ready_to_ship';

const PATCH_COLUMNS: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  description: 'description',
  barcode: 'barcode',
  unit: 'unit',
  priceMinor: 'price_minor',
  costMinor: 'cost_minor',
  reorderPoint: 'reorder_point',
};

const isOut = (p: Pick<ProductRow, 'on_hand_total'>) => p.on_hand_total <= 0;
const isLow = (p: Pick<ProductRow, 'on_hand_total' | 'reorder_point'>) =>
  p.on_hand_total > 0 && p.reorder_point !== null && p.on_hand_total <= p.reorder_point;
const needsAttention = (p: Pick<ProductRow, 'on_hand_total' | 'reorder_point'>) => (isOut(p) || isLow(p) ? 1 : 0);

/** How one product contributes to the org-wide counters. */
function contribution(p: ProductRow | null) {
  if (!p || p.deleted_at) return { products: 0, low: 0, out: 0, value: 0 };
  return {
    products: 1,
    low: isLow(p) ? 1 : 0,
    out: isOut(p) ? 1 : 0,
    value: p.on_hand_total * (p.cost_minor ?? p.price_minor),
  };
}

/** Builds a safe FTS5 prefix query from free text, or null if nothing searchable. */
function ftsQuery(q: string | undefined): string | null {
  if (!q) return null;
  const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
}

// ---------------------------------------------------------------------------
/**
 * One instance per organization. All of that organization's inventory lives in
 * this object's SQLite database, so tenants are physically isolated and all
 * writes for one tenant are serialized (no stock races).
 */
export class InventoryDO extends DurableObject<Bindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.ensureDefaultLocation();
    });
  }

  // ------------------------------------------------------------- plumbing
  private all<T = Row>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }
  private one<T = Row>(query: string, ...bindings: SqlStorageValue[]): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }
  private run(query: string, ...bindings: SqlStorageValue[]): void {
    this.sql.exec(query, ...bindings).toArray();
  }

  private migrate(): void {
    this.ctx.storage.transactionSync(() => {
      const hasMeta = this.one(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`);
      const current = hasMeta ? Number(this.one<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value ?? 0) : 0;
      for (let v = current; v < MIGRATIONS.length; v++) {
        for (const stmt of MIGRATIONS[v]) this.run(stmt);
        this.run(`INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(v + 1));
      }
    });
  }

  private ensureDefaultLocation(): void {
    if (this.one(`SELECT 1 AS x FROM locations LIMIT 1`)) return;
    this.run(`INSERT INTO locations(id, name, code, is_default, created_at) VALUES (?, 'Main', 'MAIN', 1, ?)`, newId('loc'), nowIso());
  }

  /** Runs `fn` atomically, with optional idempotent replay. Failures roll everything back. */
  private tx<T>(idem: Idem | undefined, caller: Caller, fn: () => Out<T>): Result<Out<T>> {
    try {
      const out = this.ctx.storage.transactionSync((): Out<T> => {
        const key = idem ? `${caller.actor}:${idem.key}` : null;
        if (idem && key) {
          const hit = this.one<{ request_hash: string; status: number; response: string }>(
            `SELECT request_hash, status, response FROM idempotency_keys WHERE key = ?`,
            key,
          );
          if (hit) {
            if (hit.request_hash !== idem.hash) {
              throw new Fail(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
            }
            return { status: hit.status, body: JSON.parse(hit.response) as T };
          }
        }
        const result = fn();
        if (idem && key) {
          this.run(
            `INSERT INTO idempotency_keys(key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)`,
            key, idem.hash, result.status, JSON.stringify(result.body), nowIso(),
          );
        }
        return result;
      });
      return ok(out);
    } catch (e) {
      if (e instanceof Fail) return { ok: false, status: e.status, code: e.code, detail: e.detail, extra: e.extra };
      throw e;
    }
  }

  private audit(c: Caller, action: string, entity: string, entityId: string, changes: unknown): void {
    this.run(
      `INSERT INTO audit_log(id, actor, action, entity, entity_id, changes, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('aud'), c.actor, action, entity, entityId, changes === undefined ? null : JSON.stringify(changes), c.requestId, nowIso(),
    );
  }

  private applyCounters(before: ProductRow | null, after: ProductRow | null): void {
    const b = contribution(before);
    const a = contribution(after);
    const d = { products: a.products - b.products, low: a.low - b.low, out: a.out - b.out, value: a.value - b.value };
    if (!d.products && !d.low && !d.out && !d.value) return;
    this.run(`UPDATE counters SET value = value + ? WHERE name = 'products'`, d.products);
    this.run(`UPDATE counters SET value = value + ? WHERE name = 'low_stock'`, d.low);
    this.run(`UPDATE counters SET value = value + ? WHERE name = 'out_of_stock'`, d.out);
    this.run(`UPDATE counters SET value = value + ? WHERE name = 'inventory_value_minor'`, d.value);
  }

  // ------------------------------------------------------------ mappers
  private tagsFor(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    // One bound JSON parameter: Durable Object SQLite allows at most 100 bound parameters per query.
    for (const r of this.all<{ product_id: string; tag: string }>(
      `SELECT product_id, tag FROM product_tags WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY tag`,
      JSON.stringify(ids),
    )) {
      const list = map.get(r.product_id) ?? [];
      list.push(r.tag);
      map.set(r.product_id, list);
    }
    return map;
  }

  private reservedFor(ids: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (!ids.length) return map;
    for (const r of this.all<{ product_id: string; reserved: number }>(
      `SELECT product_id, SUM(reserved) AS reserved FROM stock_levels WHERE product_id IN (SELECT value FROM json_each(?)) GROUP BY product_id`,
      JSON.stringify(ids),
    )) map.set(r.product_id, r.reserved);
    return map;
  }

  private views(rows: ProductRow[]): Product[] {
    const ids = rows.map((r) => r.id);
    const tags = this.tagsFor(ids);
    const reserved = this.reservedFor(ids);
    return rows.map((r) => {
      const res = reserved.get(r.id) ?? 0;
      return {
        id: r.id,
        sku: r.sku,
        name: r.name,
        description: r.description,
        barcode: r.barcode,
        unit: r.unit,
        priceMinor: r.price_minor,
        costMinor: r.cost_minor,
        reorderPoint: r.reorder_point,
        tags: tags.get(r.id) ?? [],
        onHand: r.on_hand_total,
        reserved: res,
        available: r.on_hand_total - res,
        status: isOut(r) ? 'out' : isLow(r) ? 'low' : 'in',
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
      };
    });
  }

  private view(row: ProductRow): Product {
    return this.views([row])[0];
  }

  private liveProduct(id: string): ProductRow {
    const row = this.one<ProductRow>(`SELECT * FROM products WHERE id = ? AND deleted_at IS NULL`, id);
    if (!row) throw new Fail(404, 'product_not_found', 'That product does not exist.');
    return row;
  }

  private activeLocation(id: string): Row {
    const row = this.one(`SELECT * FROM locations WHERE id = ? AND archived_at IS NULL`, id);
    if (!row) throw new Fail(404, 'location_not_found', 'That location does not exist.');
    return row;
  }

  private assertUnique(sku: string | null | undefined, barcode: string | null | undefined, exceptId?: string): void {
    if (sku != null && this.one(`SELECT 1 AS x FROM products WHERE sku = ? AND deleted_at IS NULL AND id <> ?`, sku, exceptId ?? '')) {
      throw new Fail(409, 'duplicate_sku', `A product with SKU ${sku} already exists.`, { errors: [{ field: 'sku', code: 'duplicate' }] });
    }
    if (barcode != null && this.one(`SELECT 1 AS x FROM products WHERE barcode = ? AND deleted_at IS NULL AND id <> ?`, barcode, exceptId ?? '')) {
      throw new Fail(409, 'duplicate_barcode', `A product with barcode ${barcode} already exists.`, { errors: [{ field: 'barcode', code: 'duplicate' }] });
    }
  }

  private reindex(row: Pick<ProductRow, 'id' | 'name' | 'sku' | 'barcode' | 'description'>): void {
    this.run(`DELETE FROM products_fts WHERE product_id = ?`, row.id);
    this.run(`INSERT INTO products_fts(product_id, name, sku, barcode, description) VALUES (?, ?, ?, ?, ?)`, row.id, row.name, row.sku, row.barcode ?? '', row.description ?? '');
  }

  private setTags(productId: string, tags: string[]): void {
    this.run(`DELETE FROM product_tags WHERE product_id = ?`, productId);
    for (const tag of new Set(tags.map((t) => t.toLowerCase()))) this.run(`INSERT INTO product_tags(product_id, tag) VALUES (?, ?)`, productId, tag);
  }

  // ------------------------------------------------- core stock mutation
  /** The only place stock changes. Must be called inside a transaction. */
  private move(c: Caller, productId: string, locationId: string, delta: number, reason: MovementReason, reference: string | null, note: string | null): { movement: Movement; stock: StockLevel } {
    const product = this.liveProduct(productId);
    const loc = this.activeLocation(locationId);
    const now = nowIso();
    this.run(`INSERT OR IGNORE INTO stock_levels(product_id, location_id, on_hand, reserved, updated_at) VALUES (?, ?, 0, 0, ?)`, productId, locationId, now);
    const level = this.one<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM stock_levels WHERE product_id = ? AND location_id = ?`, productId, locationId)!;
    const next = level.on_hand + delta;
    if (next < level.reserved) {
      const available = level.on_hand - level.reserved;
      throw new Fail(409, 'insufficient_stock', `Only ${available} unit${available === 1 ? '' : 's'} of ${product.sku} ${available === 1 ? 'is' : 'are'} available at ${String(loc.name)}.`, {
        errors: [{ field: 'delta', code: 'insufficient_stock' }],
      });
    }
    if (next > LIMITS.maxOnHand) {
      throw new Fail(409, 'stock_limit', `Stock of ${product.sku} cannot exceed ${LIMITS.maxOnHand.toLocaleString('en-US')} units at one location.`);
    }
    const movementId = newId('mov');
    this.run(`UPDATE stock_levels SET on_hand = ?, updated_at = ? WHERE product_id = ? AND location_id = ?`, next, now, productId, locationId);
    this.run(
      `INSERT INTO stock_movements(id, product_id, location_id, delta, reason, reference, note, balance, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      movementId, productId, locationId, delta, reason, reference, note, next, c.actor, now,
    );
    const after: ProductRow = { ...product, on_hand_total: product.on_hand_total + delta };
    this.run(`UPDATE products SET on_hand_total = ?, attention = ? WHERE id = ?`, after.on_hand_total, needsAttention(after), productId);
    this.applyCounters(product, after);
    // New stock goes to the oldest waiting orders first.
    if (delta > 0) this.allocateWaiting(productId, locationId);
    const reservedNow = this.one<{ reserved: number }>(`SELECT reserved FROM stock_levels WHERE product_id = ? AND location_id = ?`, productId, locationId)!.reserved;
    return {
      movement: { id: movementId, productId, locationId, delta, reason, reference, note, balance: next, actor: c.actor, createdAt: now },
      stock: { productId, locationId, onHand: next, reserved: reservedNow, available: next - reservedNow },
    };
  }

  // ------------------------------------------------------------- reservations
  /** Holds up to `want` available units for an order. Returns how many were held. */
  private reserveUpTo(productId: string, locationId: string, want: number): number {
    this.run(`INSERT OR IGNORE INTO stock_levels(product_id, location_id, on_hand, reserved, updated_at) VALUES (?, ?, 0, 0, ?)`, productId, locationId, nowIso());
    const lvl = this.one<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM stock_levels WHERE product_id = ? AND location_id = ?`, productId, locationId)!;
    const take = Math.max(0, Math.min(lvl.on_hand - lvl.reserved, want));
    if (take > 0) this.run(`UPDATE stock_levels SET reserved = reserved + ? WHERE product_id = ? AND location_id = ?`, take, productId, locationId);
    return take;
  }

  /** Gives free units to waiting order lines, oldest order first, then refreshes those orders' states. */
  private allocateWaiting(productId: string, locationId: string): void {
    const waiting = this.all<{ id: string; order_id: string; quantity: number; reserved: number }>(
      `SELECT l.id, l.order_id, l.quantity, l.reserved FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE l.open = 1 AND l.reserved < l.quantity AND l.product_id = ? AND o.location_id = ?
        ORDER BY o.created_at ASC, l.id ASC`,
      productId, locationId,
    );
    const touched = new Set<string>();
    for (const l of waiting) {
      const got = this.reserveUpTo(productId, locationId, l.quantity - l.reserved);
      if (got === 0) break;
      this.run(`UPDATE order_lines SET reserved = reserved + ? WHERE id = ?`, got, l.id);
      touched.add(l.order_id);
    }
    for (const id of touched) this.refreshOrderState(id);
  }

  private refreshOrderState(orderId: string): void {
    const o = this.one<OrderRow>(`SELECT * FROM orders WHERE id = ?`, orderId);
    if (!o || o.state === 'shipped' || o.state === 'cancelled') return;
    const next = openState(o.paid === 1, this.all<LineRow>(`SELECT * FROM order_lines WHERE order_id = ?`, orderId));
    // Automatic changes do not bump the version, so a user's pending Ship click is not rejected as stale.
    if (next !== o.state) this.run(`UPDATE orders SET state = ?, updated_at = ? WHERE id = ?`, next, nowIso(), orderId);
  }

  // ----------------------------------------------------------- products
  createProduct(c: Caller, idem: Idem | undefined, input: ProductInput): Result<Out<{ product: Product }>> {
    return this.tx(idem, c, () => this.doCreate(c, input));
  }

  private doCreate(c: Caller, input: ProductInput): Out<{ product: Product }> {
    {
      this.assertUnique(input.sku, input.barcode ?? null);
      const id = newId('prd');
      const now = nowIso();
      this.run(
        `INSERT INTO products(id, sku, name, description, barcode, unit, price_minor, cost_minor, reorder_point, on_hand_total, attention, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
        id, input.sku, input.name, input.description ?? null, input.barcode ?? null, input.unit, input.priceMinor, input.costMinor ?? null, input.reorderPoint ?? null, now, now,
      );
      this.setTags(id, input.tags);
      this.reindex({ id, name: input.name, sku: input.sku, barcode: input.barcode ?? null, description: input.description ?? null });
      this.applyCounters(null, this.one<ProductRow>(`SELECT * FROM products WHERE id = ?`, id));
      if (input.initialQuantity > 0) {
        const def = this.one<{ id: string }>(`SELECT id FROM locations WHERE is_default = 1 AND archived_at IS NULL`);
        if (!def) throw new Fail(409, 'no_default_location', 'Create a location before adding stock.');
        this.move(c, id, def.id, input.initialQuantity, 'receive', null, 'Initial stock');
      }
      this.audit(c, 'product.create', 'product', id, { sku: input.sku, name: input.name });
      return { status: 201, body: { product: this.view(this.one<ProductRow>(`SELECT * FROM products WHERE id = ?`, id)!) } };
    }
  }

  updateProduct(c: Caller, idem: Idem | undefined, id: string, expectedVersion: number, patch: ProductPatch): Result<Out<{ product: Product }>> {
    return this.tx(idem, c, () => this.doUpdate(c, id, expectedVersion, patch));
  }

  private doUpdate(c: Caller, id: string, expectedVersion: number, patch: ProductPatch): Out<{ product: Product }> {
    {
      const before = this.liveProduct(id);
      if (before.version !== expectedVersion) {
        throw new Fail(412, 'version_conflict', 'Someone else changed this product. Review their changes before saving.', { current: this.view(before) });
      }
      if (patch.sku !== undefined || patch.barcode !== undefined) {
        this.assertUnique(patch.sku !== undefined && patch.sku !== before.sku ? patch.sku : null, patch.barcode !== undefined && patch.barcode !== before.barcode ? patch.barcode : null, id);
      }
      const sets: string[] = [];
      const args: SqlStorageValue[] = [];
      const changes: Record<string, [unknown, unknown]> = {};
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        if (!(key in patch)) continue;
        const next = (patch as Record<string, unknown>)[key] ?? null;
        const prev = (before as unknown as Record<string, unknown>)[column] ?? null;
        if (next === prev) continue;
        sets.push(`${column} = ?`);
        args.push(next as SqlStorageValue);
        changes[key] = [prev, next];
      }
      let tagsChanged = false;
      if (patch.tags !== undefined) {
        const prevTags = (this.tagsFor([id]).get(id) ?? []).join(',');
        const nextTags = [...new Set(patch.tags.map((t) => t.toLowerCase()))].sort().join(',');
        if (prevTags !== nextTags) {
          tagsChanged = true;
          changes.tags = [prevTags ? prevTags.split(',') : [], nextTags ? nextTags.split(',') : []];
        }
      }
      if (!sets.length && !tagsChanged) return { status: 200, body: { product: this.view(before) } };
      const reorder = 'reorderPoint' in patch ? (patch.reorderPoint ?? null) : before.reorder_point;
      sets.push('attention = ?', 'version = version + 1', 'updated_at = ?');
      args.push(needsAttention({ on_hand_total: before.on_hand_total, reorder_point: reorder }), nowIso(), id);
      this.run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, ...args);
      if (tagsChanged) this.setTags(id, patch.tags!);
      const after = this.one<ProductRow>(`SELECT * FROM products WHERE id = ?`, id)!;
      this.reindex(after);
      this.applyCounters(before, after);
      this.audit(c, 'product.update', 'product', id, changes);
      return { status: 200, body: { product: this.view(after) } };
    }
  }

  deleteProduct(c: Caller, id: string, expectedVersion: number): Result<Out<{ id: string }>> {
    return this.tx(undefined, c, () => {
      const before = this.liveProduct(id);
      if (before.version !== expectedVersion) {
        throw new Fail(412, 'version_conflict', 'Someone else changed this product. Review their changes before deleting.', { current: this.view(before) });
      }
      if (this.one(`SELECT 1 AS x FROM order_lines WHERE product_id = ? AND open = 1 LIMIT 1`, id)) {
        throw new Fail(409, 'product_in_use', 'This product is on open orders. Ship or cancel them first.');
      }
      this.run(`UPDATE products SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), id);
      this.run(`DELETE FROM products_fts WHERE product_id = ?`, id);
      this.applyCounters(before, this.one<ProductRow>(`SELECT * FROM products WHERE id = ?`, id));
      this.audit(c, 'product.delete', 'product', id, { sku: before.sku });
      return { status: 200, body: { id } };
    });
  }

  restoreProduct(c: Caller, id: string): Result<Out<{ product: Product }>> {
    return this.tx(undefined, c, () => {
      const before = this.one<ProductRow>(`SELECT * FROM products WHERE id = ? AND deleted_at IS NOT NULL`, id);
      if (!before) throw new Fail(404, 'product_not_found', 'That deleted product does not exist.');
      this.assertUnique(before.sku, before.barcode, id);
      this.run(`UPDATE products SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), id);
      const after = this.one<ProductRow>(`SELECT * FROM products WHERE id = ?`, id)!;
      this.reindex(after);
      this.applyCounters(before, after);
      this.audit(c, 'product.restore', 'product', id, { sku: before.sku });
      return { status: 200, body: { product: this.view(after) } };
    });
  }

  getProduct(id: string): Result<{ product: Product; levels: StockLevel[] }> {
    const row = this.one<ProductRow>(`SELECT * FROM products WHERE id = ? AND deleted_at IS NULL`, id);
    if (!row) return { ok: false, status: 404, code: 'product_not_found', detail: 'That product does not exist.' };
    return ok({ product: this.view(row), levels: this.levelsFor(id) });
  }

  lookupProduct(code: string): Result<{ product: Product; levels: StockLevel[] }> {
    const row = this.one<ProductRow>(`SELECT * FROM products WHERE (barcode = ?1 OR sku = ?1) AND deleted_at IS NULL`, code);
    if (!row) return { ok: false, status: 404, code: 'product_not_found', detail: `Nothing matches ${code}.` };
    return ok({ product: this.view(row), levels: this.levelsFor(row.id) });
  }

  private levelsFor(productId: string): StockLevel[] {
    return this.all<{ location_id: string; on_hand: number; reserved: number }>(`SELECT location_id, on_hand, reserved FROM stock_levels WHERE product_id = ? ORDER BY location_id`, productId).map((l) => ({
      productId,
      locationId: l.location_id,
      onHand: l.on_hand,
      reserved: l.reserved,
      available: l.on_hand - l.reserved,
    }));
  }

  listProducts(q: ProductListQuery): Page<Product> {
    const where: string[] = ['p.deleted_at IS NULL'];
    const args: SqlStorageValue[] = [];
    const match = ftsQuery(q.q);
    if (q.q && !match) return { data: [], nextCursor: null, hasMore: false };
    if (match) {
      where.push(`p.id IN (SELECT product_id FROM products_fts WHERE products_fts MATCH ?)`);
      args.push(match);
    }
    if (q.stock === 'out') where.push('p.on_hand_total <= 0');
    else if (q.stock === 'low') where.push('p.attention = 1 AND p.on_hand_total > 0');
    else if (q.stock === 'in') where.push('p.on_hand_total > 0');
    if (q.location) {
      where.push(`EXISTS (SELECT 1 FROM stock_levels s WHERE s.product_id = p.id AND s.location_id = ? AND s.on_hand > 0)`);
      args.push(q.location);
    }
    if (q.tag) {
      where.push(`EXISTS (SELECT 1 FROM product_tags t WHERE t.product_id = p.id AND t.tag = ?)`);
      args.push(q.tag.toLowerCase());
    }
    let order: string;
    if (q.sort === 'name') {
      order = 'p.name COLLATE NOCASE ASC, p.id ASC';
      const cur = decodeCursor<{ n: string; i: string }>(q.cursor);
      if (cur) {
        where.push('(p.name COLLATE NOCASE > ? OR (p.name COLLATE NOCASE = ? AND p.id > ?))');
        args.push(cur.n, cur.n, cur.i);
      }
    } else {
      order = 'p.updated_at DESC, p.id DESC';
      const cur = decodeCursor<{ u: string; i: string }>(q.cursor);
      if (cur) {
        where.push('(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))');
        args.push(cur.u, cur.u, cur.i);
      }
    }
    const rows = this.all<ProductRow>(`SELECT p.* FROM products p WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...args, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(q.sort === 'name' ? { n: last.name, i: last.id } : { u: last.updated_at, i: last.id }) : null;
    return { data: this.views(page), nextCursor, hasMore };
  }

  dashboard(): Dashboard {
    const counters = Object.fromEntries(this.all<{ name: string; value: number }>(`SELECT name, value FROM counters`).map((r) => [r.name, r.value]));
    const attention = this.all<ProductRow>(`SELECT * FROM products WHERE attention = 1 AND deleted_at IS NULL ORDER BY on_hand_total ASC, id ASC LIMIT 10`);
    return {
      orders: this.orderCounts(),
      products: counters.products ?? 0,
      lowStock: counters.low_stock ?? 0,
      outOfStock: counters.out_of_stock ?? 0,
      inventoryValueMinor: counters.inventory_value_minor ?? 0,
      needsAttention: this.views(attention),
      recentMovements: this.listMovements({ limit: 20 }).data,
    };
  }

  // ---------------------------------------------------------- locations
  listLocations(): Location[] {
    return this.all<{ id: string; name: string; code: string; is_default: number; archived_at: string | null }>(`SELECT * FROM locations ORDER BY is_default DESC, name COLLATE NOCASE`).map((l) => ({
      id: l.id, name: l.name, code: l.code, isDefault: l.is_default === 1, archivedAt: l.archived_at,
    }));
  }

  createLocation(c: Caller, input: LocationInput): Result<Out<{ location: Location }>> {
    return this.tx(undefined, c, () => {
      if (this.all(`SELECT 1 AS x FROM locations WHERE code = ? AND archived_at IS NULL`, input.code).length) {
        throw new Fail(409, 'duplicate_code', `A location with code ${input.code} already exists.`, { errors: [{ field: 'code', code: 'duplicate' }] });
      }
      if (this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM locations WHERE archived_at IS NULL`)!.n >= 50) {
        throw new Fail(409, 'location_limit', 'An organization can have at most 50 locations.');
      }
      const id = newId('loc');
      this.run(`INSERT INTO locations(id, name, code, is_default, created_at) VALUES (?, ?, ?, 0, ?)`, id, input.name, input.code, nowIso());
      this.audit(c, 'location.create', 'location', id, input);
      return { status: 201, body: { location: this.listLocations().find((l) => l.id === id)! } };
    });
  }

  archiveLocation(c: Caller, id: string): Result<Out<{ id: string }>> {
    return this.tx(undefined, c, () => {
      const loc = this.activeLocation(id);
      if (loc.is_default === 1) throw new Fail(409, 'default_location', 'The default location cannot be archived.');
      if (this.one(`SELECT 1 AS x FROM stock_levels WHERE location_id = ? AND on_hand > 0 LIMIT 1`, id)) {
        throw new Fail(409, 'location_has_stock', 'Move the remaining stock out of this location first.');
      }
      this.run(`UPDATE locations SET archived_at = ? WHERE id = ?`, nowIso(), id);
      this.audit(c, 'location.archive', 'location', id, null);
      return { status: 200, body: { id } };
    });
  }

  // -------------------------------------------------------------- stock
  addMovement(c: Caller, idem: Idem | undefined, input: MovementInput): Result<Out<{ movement: Movement; stock: StockLevel }>> {
    return this.tx(idem, c, () => ({
      status: 201,
      body: this.move(c, input.productId, input.locationId, input.delta, input.reason, input.reference ?? null, input.note ?? null),
    }));
  }

  transfer(c: Caller, idem: Idem | undefined, input: TransferInput): Result<Out<{ transferId: string; out: { movement: Movement; stock: StockLevel }; in: { movement: Movement; stock: StockLevel } }>> {
    return this.tx(idem, c, () => {
      const transferId = newId('trf');
      const ref = input.reference ?? transferId;
      const out = this.move(c, input.productId, input.fromLocationId, -input.quantity, 'transfer_out', ref, input.note ?? null);
      const inn = this.move(c, input.productId, input.toLocationId, input.quantity, 'transfer_in', ref, input.note ?? null);
      return { status: 201, body: { transferId, out, in: inn } };
    });
  }

  /** Stock count: the client says what is on the shelf; the server records the difference. */
  count(c: Caller, idem: Idem | undefined, input: CountInput): Result<Out<{ movement: Movement | null; stock: StockLevel }>> {
    return this.tx(idem, c, (): Out<{ movement: Movement | null; stock: StockLevel }> => {
      this.liveProduct(input.productId);
      this.activeLocation(input.locationId);
      const level = this.one<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM stock_levels WHERE product_id = ? AND location_id = ?`, input.productId, input.locationId);
      const onHand = level?.on_hand ?? 0;
      const delta = input.counted - onHand;
      if (delta === 0) {
        return { status: 200, body: { movement: null, stock: { productId: input.productId, locationId: input.locationId, onHand, reserved: level?.reserved ?? 0, available: onHand - (level?.reserved ?? 0) } } };
      }
      return { status: 201, body: this.move(c, input.productId, input.locationId, delta, 'count', null, input.note ?? null) };
    });
  }

  listMovements(q: MovementListQuery): Page<Movement> {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (q.productId) { where.push('m.product_id = ?'); args.push(q.productId); }
    if (q.locationId) { where.push('m.location_id = ?'); args.push(q.locationId); }
    if (q.reason) { where.push('m.reason = ?'); args.push(q.reason); }
    const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
    if (cur) { where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))'); args.push(cur.c, cur.c, cur.i); }
    const rows = this.all<Row>(
      `SELECT m.*, p.name AS product_name, p.sku AS product_sku FROM stock_movements m LEFT JOIN products p ON p.id = m.product_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      ...args, q.limit + 1,
    );
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        id: r.id as string,
        productId: r.product_id as string,
        productName: (r.product_name as string | null) ?? undefined,
        productSku: (r.product_sku as string | null) ?? undefined,
        locationId: r.location_id as string,
        delta: r.delta as number,
        reason: r.reason as MovementReason,
        reference: r.reference as string | null,
        note: r.note as string | null,
        balance: r.balance as number,
        actor: r.actor as string,
        createdAt: r.created_at as string,
      })),
      nextCursor: hasMore && last ? encodeCursor({ c: last.created_at, i: last.id }) : null,
      hasMore,
    };
  }

  listAudit(q: { limit: number; cursor?: string }): Page<AuditEntry> {
    const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
    const rows = this.all<Row>(
      `SELECT * FROM audit_log ${cur ? 'WHERE (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...(cur ? [cur.c, cur.c, cur.i] : []), q.limit + 1,
    );
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r): AuditEntry => ({
        id: r.id as string, actor: r.actor as string, action: r.action as string, entity: r.entity as string, entityId: r.entity_id as string,
        changes: r.changes ? JSON.parse(r.changes as string) : null, requestId: r.request_id as string, createdAt: r.created_at as string,
      })),
      nextCursor: hasMore && last ? encodeCursor({ c: last.created_at, i: last.id }) : null,
      hasMore,
    };
  }

  // ------------------------------------------------------------------ import
  private defaultLocationId(): string {
    const def = this.one<{ id: string }>(`SELECT id FROM locations WHERE is_default = 1 AND archived_at IS NULL`);
    if (!def) throw new Fail(409, 'no_default_location', 'Create a location before importing stock.');
    return def.id;
  }

  /** Brings a product's stock at the default location to `quantity` by recording the difference. */
  private setImportedQuantity(c: Caller, productId: string, quantity: number): boolean {
    const loc = this.defaultLocationId();
    const onHand = this.one<{ on_hand: number }>(`SELECT on_hand FROM stock_levels WHERE product_id = ? AND location_id = ?`, productId, loc)?.on_hand ?? 0;
    if (quantity === onHand) return false;
    this.move(c, productId, loc, quantity - onHand, 'import', 'CSV import', null);
    return true;
  }

  private importRow(c: Caller, mode: 'create' | 'upsert', index: number, row: ImportRow): ImportResult {
    const existing = this.one<ProductRow>(`SELECT * FROM products WHERE sku = ? AND deleted_at IS NULL`, row.sku);
    if (!existing) {
      const made = this.doCreate(c, {
        sku: row.sku, name: row.name, description: row.description ?? null, barcode: row.barcode ?? null, unit: row.unit ?? 'each', priceMinor: row.priceMinor,
        costMinor: row.costMinor ?? null, reorderPoint: row.reorderPoint ?? null, tags: row.tags ?? [], initialQuantity: 0,
      }).body.product;
      if (row.quantity) this.setImportedQuantity(c, made.id, row.quantity);
      return { index, sku: row.sku, status: 'created', id: made.id };
    }
    if (mode === 'create') throw new Fail(409, 'duplicate_sku', `SKU ${row.sku} already exists. Choose "create or update" to change it.`);
    const patch: ProductPatch = { name: row.name, priceMinor: row.priceMinor };
    if (row.description !== undefined) patch.description = row.description;
    if (row.barcode !== undefined) patch.barcode = row.barcode;
    if (row.unit !== undefined) patch.unit = row.unit;
    if (row.costMinor !== undefined) patch.costMinor = row.costMinor;
    if (row.reorderPoint !== undefined) patch.reorderPoint = row.reorderPoint;
    if (row.tags !== undefined) patch.tags = row.tags;
    const updated = this.doUpdate(c, existing.id, existing.version, patch).body.product;
    let changed = updated.version !== existing.version;
    if (row.quantity !== undefined && this.setImportedQuantity(c, existing.id, row.quantity)) changed = true;
    return { index, sku: row.sku, status: changed ? 'updated' : 'unchanged', id: existing.id };
  }

  /**
   * Imports up to 100 rows. Each row is its own transaction, so one bad row never blocks the others.
   * Replaying the same Idempotency-Key returns the original results without repeating anything.
   */
  importProducts(c: Caller, idem: Idem | undefined, mode: 'create' | 'upsert', rows: { index: number; row: ImportRow }[]): Result<Out<{ results: ImportResult[] }>> {
    const key = idem ? `${c.actor}:${idem.key}` : null;
    if (idem && key) {
      const hit = this.one<{ request_hash: string; status: number; response: string }>(`SELECT request_hash, status, response FROM idempotency_keys WHERE key = ?`, key);
      if (hit) {
        if (hit.request_hash !== idem.hash) return { ok: false, status: 422, code: 'idempotency_key_reused', detail: 'This Idempotency-Key was already used with a different request.' };
        return ok({ status: hit.status, body: JSON.parse(hit.response) as { results: ImportResult[] } });
      }
    }
    const results: ImportResult[] = rows.map(({ index, row }) => {
      try {
        return this.ctx.storage.transactionSync(() => this.importRow(c, mode, index, row));
      } catch (e) {
        if (e instanceof Fail) return { index, sku: row.sku, status: 'error' as const, error: e.detail };
        throw e;
      }
    });
    const out = { status: 200, body: { results } };
    if (idem && key) {
      this.run(`INSERT INTO idempotency_keys(key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)`, key, idem.hash, out.status, JSON.stringify(out.body), nowIso());
    }
    return ok(out);
  }

  // ------------------------------------------------------------- orders
  private orderViews(rows: OrderRow[]): Order[] {
    if (!rows.length) return [];
    const byOrder = new Map<string, LineRow[]>();
    for (const l of this.all<LineRow>(`SELECT * FROM order_lines WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY id`, JSON.stringify(rows.map((r) => r.id)))) {
      const list = byOrder.get(l.order_id) ?? [];
      list.push(l);
      byOrder.set(l.order_id, list);
    }
    return rows.map((r) => {
      const lines = byOrder.get(r.id) ?? [];
      return {
        id: r.id, number: r.number, channel: r.channel, customerName: r.customer_name, customerEmail: r.customer_email, country: r.country, note: r.note,
        locationId: r.location_id, paid: r.paid === 1, state: r.state,
        totalMinor: lines.reduce((sum, l) => sum + l.quantity * l.unit_price_minor, 0),
        lines: lines.map((l) => ({ id: l.id, productId: l.product_id, sku: l.sku, name: l.name, quantity: l.quantity, reserved: l.reserved, unitPriceMinor: l.unit_price_minor })),
        version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, shippedAt: r.shipped_at,
      };
    });
  }

  private orderRow(id: string): OrderRow {
    const row = this.one<OrderRow>(`SELECT * FROM orders WHERE id = ?`, id);
    if (!row) throw new Fail(404, 'order_not_found', 'That order does not exist.');
    return row;
  }

  private orderCounts(): OrderCounts {
    const counts: OrderCounts = { payment_required: 0, waiting_for_stock: 0, ready_to_ship: 0, shipped: 0, cancelled: 0 };
    for (const r of this.all<{ state: OrderState; n: number }>(`SELECT state, COUNT(*) AS n FROM orders GROUP BY state`)) counts[r.state] = r.n;
    return counts;
  }

  createOrder(c: Caller, idem: Idem | undefined, input: OrderInput): Result<Out<{ order: Order }>> {
    return this.tx(idem, c, () => {
      const locationId = input.locationId ?? this.one<{ id: string }>(`SELECT id FROM locations WHERE is_default = 1 AND archived_at IS NULL`)?.id;
      if (!locationId) throw new Fail(409, 'no_default_location', 'Create a location first.');
      this.activeLocation(locationId);
      const id = newId('ord');
      const now = nowIso();
      this.run(`UPDATE counters SET value = value + 1 WHERE name = 'order_seq'`);
      const number = `ORD-${this.one<{ value: number }>(`SELECT value FROM counters WHERE name = 'order_seq'`)!.value}`;
      this.run(
        `INSERT INTO orders(id, number, channel, customer_name, customer_email, country, note, location_id, paid, state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'payment_required', 1, ?, ?)`,
        id, number, input.channel, input.customerName, input.customerEmail ?? null, input.country ?? null, input.note ?? null, locationId, input.paid ? 1 : 0, now, now,
      );
      const made: { quantity: number; reserved: number }[] = [];
      for (const line of input.lines) {
        const p = this.liveProduct(line.productId);
        const reserved = this.reserveUpTo(p.id, locationId, line.quantity);
        this.run(`INSERT INTO order_lines(id, order_id, product_id, quantity, reserved, unit_price_minor, sku, name, open) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`, newId('oln'), id, p.id, line.quantity, reserved, p.price_minor, p.sku, p.name);
        made.push({ quantity: line.quantity, reserved });
      }
      this.run(`UPDATE orders SET state = ? WHERE id = ?`, openState(input.paid, made), id);
      this.audit(c, 'order.create', 'order', id, { number, customer: input.customerName, lines: input.lines.length });
      return { status: 201, body: { order: this.orderViews([this.orderRow(id)])[0] } };
    });
  }

  getOrder(id: string): Result<{ order: Order }> {
    const row = this.one<OrderRow>(`SELECT * FROM orders WHERE id = ?`, id);
    if (!row) return { ok: false, status: 404, code: 'order_not_found', detail: 'That order does not exist.' };
    return ok({ order: this.orderViews([row])[0] });
  }

  listOrders(q: OrderListQuery): Page<Order> {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (q.state) { where.push('o.state = ?'); args.push(q.state); }
    if (q.q) {
      const like = `${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(o.number LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
    const cur = decodeCursor<{ c: string; i: string }>(q.cursor);
    if (cur) { where.push('(o.created_at < ? OR (o.created_at = ? AND o.id < ?))'); args.push(cur.c, cur.c, cur.i); }
    const rows = this.all<OrderRow>(`SELECT o.* FROM orders o ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, ...args, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: this.orderViews(page), nextCursor: hasMore && last ? encodeCursor({ c: last.created_at, i: last.id }) : null, hasMore };
  }

  private guardOrder(id: string, version: number): OrderRow {
    const row = this.orderRow(id);
    if (row.version !== version) {
      throw new Fail(412, 'version_conflict', 'This order changed. Review it and try again.', { current: this.orderViews([row])[0] });
    }
    if (row.state === 'shipped' || row.state === 'cancelled') throw new Fail(409, 'order_closed', `This order is already ${row.state}.`);
    return row;
  }

  setOrderPaid(c: Caller, id: string, version: number, paid: boolean): Result<Out<{ order: Order }>> {
    return this.tx(undefined, c, () => {
      const row = this.guardOrder(id, version);
      this.run(`UPDATE orders SET paid = ?, version = version + 1, updated_at = ? WHERE id = ?`, paid ? 1 : 0, nowIso(), id);
      this.refreshOrderState(id);
      this.audit(c, paid ? 'order.paid' : 'order.unpaid', 'order', id, { number: row.number });
      return { status: 200, body: { order: this.orderViews([this.orderRow(id)])[0] } };
    });
  }

  shipOrder(c: Caller, id: string, version: number): Result<Out<{ order: Order }>> {
    return this.tx(undefined, c, () => {
      const row = this.guardOrder(id, version);
      if (row.state !== 'ready_to_ship') {
        throw new Fail(409, 'not_ready', row.state === 'payment_required' ? 'Mark the order as paid before shipping it.' : 'Some items are not in stock yet. Receive stock first.');
      }
      for (const l of this.all<LineRow>(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY id`, id)) {
        // Release the hold, then record the sale; both in this transaction.
        this.run(`UPDATE stock_levels SET reserved = reserved - ? WHERE product_id = ? AND location_id = ?`, l.reserved, l.product_id, row.location_id);
        this.move(c, l.product_id, row.location_id, -l.quantity, 'sale', row.number, null);
        this.run(`UPDATE order_lines SET open = 0 WHERE id = ?`, l.id);
      }
      this.run(`UPDATE orders SET state = 'shipped', shipped_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), id);
      this.audit(c, 'order.ship', 'order', id, { number: row.number });
      return { status: 200, body: { order: this.orderViews([this.orderRow(id)])[0] } };
    });
  }

  cancelOrder(c: Caller, id: string, version: number): Result<Out<{ order: Order }>> {
    return this.tx(undefined, c, () => {
      const row = this.guardOrder(id, version);
      const lines = this.all<LineRow>(`SELECT * FROM order_lines WHERE order_id = ?`, id);
      for (const l of lines) {
        if (l.reserved > 0) this.run(`UPDATE stock_levels SET reserved = reserved - ? WHERE product_id = ? AND location_id = ?`, l.reserved, l.product_id, row.location_id);
        this.run(`UPDATE order_lines SET reserved = 0, open = 0 WHERE id = ?`, l.id);
      }
      this.run(`UPDATE orders SET state = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), id);
      // Freed units may now satisfy orders that were waiting.
      for (const l of lines) this.allocateWaiting(l.product_id, row.location_id);
      this.audit(c, 'order.cancel', 'order', id, { number: row.number });
      return { status: 200, body: { order: this.orderViews([this.orderRow(id)])[0] } };
    });
  }

  // ---------------------------------------------------------- integrity
  /** Verifies invariants I1 and I6. Run nightly; any drift is a sev-1 incident. */
  verifyIntegrity(): { ok: boolean; drift: string[] } {
    const drift: string[] = [];
    for (const r of this.all(
      `SELECT s.product_id, s.location_id, s.on_hand AS level, COALESCE(m.total, 0) AS ledger
       FROM stock_levels s LEFT JOIN (SELECT product_id, location_id, SUM(delta) AS total FROM stock_movements GROUP BY product_id, location_id) m
         ON m.product_id = s.product_id AND m.location_id = s.location_id
       WHERE s.on_hand <> COALESCE(m.total, 0)`,
    )) drift.push(JSON.stringify({ invariant: 'I1', ...r }));
    for (const r of this.all(
      `SELECT p.id AS product_id, p.on_hand_total AS total, COALESCE(SUM(s.on_hand), 0) AS levels
       FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id GROUP BY p.id HAVING total <> levels`,
    )) drift.push(JSON.stringify({ invariant: 'I1-total', ...r }));
    for (const r of this.all(
      `SELECT s.product_id, s.location_id, s.reserved AS level, COALESCE(r.total, 0) AS lines
       FROM stock_levels s LEFT JOIN (
         SELECT l.product_id, o.location_id, SUM(l.reserved) AS total FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.open = 1 GROUP BY l.product_id, o.location_id
       ) r ON r.product_id = s.product_id AND r.location_id = s.location_id
       WHERE s.reserved <> COALESCE(r.total, 0)`,
    )) drift.push(JSON.stringify({ invariant: 'I3', ...r }));
    const live = this.all<ProductRow>(`SELECT * FROM products WHERE deleted_at IS NULL`);
    const want = live.reduce((acc, p) => {
      const k = contribution(p);
      return { products: acc.products + k.products, low: acc.low + k.low, out: acc.out + k.out, value: acc.value + k.value };
    }, { products: 0, low: 0, out: 0, value: 0 });
    const have = Object.fromEntries(this.all<{ name: string; value: number }>(`SELECT name, value FROM counters`).map((r) => [r.name, r.value]));
    if (have.products !== want.products || have.low_stock !== want.low || have.out_of_stock !== want.out || have.inventory_value_minor !== want.value) {
      drift.push(JSON.stringify({ invariant: 'I6', want, have }));
    }
    return { ok: drift.length === 0, drift };
  }
}
