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
import { lineTax, type TaxMode } from '@shoplist/shared';
import { APPROVAL_DEFAULTS, type ApprovalRules, type ApprovalView, type Customer, type CustomerInput, type CountTask, type CountTaskInput, type PoState, type PurchaseOrder, type PurchaseOrderInput, type ReceiveInput, type ReportName, type ReportResult, type Supplier, type SupplierInput } from '@shoplist/shared';
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
  // Step 3: webhook outbox. Events are written in the same transaction as the change they describe.
  [
    `CREATE TABLE outbox (
       id TEXT PRIMARY KEY,
       type TEXT NOT NULL,
       data TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX outbox_created ON outbox(created_at, id)`,
  ],
  // Step 4: order the outbox by an insertion sequence. Timestamps tie within a millisecond and ids are random,
  // so ordering by them could deliver events out of order.
  [
    `DROP TABLE outbox`,
    `CREATE TABLE outbox (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       id TEXT NOT NULL UNIQUE,
       type TEXT NOT NULL,
       data TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`,
  ],
  // Step 5: approval requests. A risky action waits here, as the exact validated input, until someone with
  // approvals:decide approves it (applied through the normal code path) or rejects it.
  [
    `CREATE TABLE approval_requests (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       payload TEXT NOT NULL,
       summary TEXT NOT NULL,
       requested_by TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('pending','approved','applied','rejected','withdrawn','expired','failed')),
       decided_by TEXT,
       note TEXT,
       created_at TEXT NOT NULL,
       decided_at TEXT,
       expires_at TEXT NOT NULL
     )`,
    `CREATE INDEX approvals_state ON approval_requests(state, created_at DESC)`,
  ],
  // Step 6: daily rollups for reports. Updated in the same transaction as every movement and shipment, so they are
  // exact; invariant I8 checks them against the ledger. The days of history are filled in from the ledger here.
  [
    `CREATE TABLE daily_stats (
       day TEXT NOT NULL,
       product_id TEXT NOT NULL,
       location_id TEXT NOT NULL,
       sold_qty INTEGER NOT NULL DEFAULT 0,
       sold_minor INTEGER NOT NULL DEFAULT 0,
       received_qty INTEGER NOT NULL DEFAULT 0,
       returned_qty INTEGER NOT NULL DEFAULT 0,
       adjusted_qty INTEGER NOT NULL DEFAULT 0,
       damaged_qty INTEGER NOT NULL DEFAULT 0,
       count_delta INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (day, product_id, location_id)
     )`,
    `CREATE INDEX daily_stats_product ON daily_stats(product_id, day)`,
    `INSERT INTO daily_stats(day, product_id, location_id, sold_qty, received_qty, returned_qty, adjusted_qty, damaged_qty, count_delta)
       SELECT substr(created_at, 1, 10), product_id, location_id,
              SUM(CASE WHEN reason = 'sale' THEN -delta ELSE 0 END), SUM(CASE WHEN reason = 'receive' THEN delta ELSE 0 END),
              SUM(CASE WHEN reason = 'return' THEN delta ELSE 0 END), SUM(CASE WHEN reason = 'adjust' THEN delta ELSE 0 END),
              SUM(CASE WHEN reason = 'damage' THEN -delta ELSE 0 END), SUM(CASE WHEN reason = 'count' THEN delta ELSE 0 END)
         FROM stock_movements GROUP BY 1, 2, 3`,
    `INSERT INTO daily_stats(day, product_id, location_id, sold_minor)
       SELECT substr(o.shipped_at, 1, 10), l.product_id, o.location_id, SUM(l.quantity * l.unit_price_minor)
         FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.state = 'shipped' AND o.shipped_at IS NOT NULL GROUP BY 1, 2, 3
       ON CONFLICT(day, product_id, location_id) DO UPDATE SET sold_minor = excluded.sold_minor`,
  ],
  // Step 7: suppliers and purchase orders. "On order" is computed from open lines, never stored, so it cannot drift.
  [
    `CREATE TABLE suppliers (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       email TEXT,
       phone TEXT,
       lead_time_days INTEGER,
       note TEXT,
       created_at TEXT NOT NULL,
       archived_at TEXT
     )`,
    `CREATE TABLE purchase_orders (
       id TEXT PRIMARY KEY,
       number TEXT NOT NULL UNIQUE,
       supplier_id TEXT NOT NULL REFERENCES suppliers(id),
       location_id TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('draft','sent','partially_received','received','cancelled','closed')),
       expected_at TEXT,
       note TEXT,
       created_by TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       version INTEGER NOT NULL DEFAULT 1
     )`,
    `CREATE INDEX po_state ON purchase_orders(state, created_at DESC)`,
    `CREATE TABLE po_lines (
       id TEXT PRIMARY KEY,
       po_id TEXT NOT NULL REFERENCES purchase_orders(id),
       product_id TEXT NOT NULL,
       quantity INTEGER NOT NULL CHECK (quantity > 0),
       received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= quantity),
       unit_cost_minor INTEGER NOT NULL
     )`,
    `CREATE INDEX po_lines_po ON po_lines(po_id)`,
    `CREATE INDEX po_lines_product ON po_lines(product_id)`,
    `INSERT INTO counters(name, value) VALUES ('po_seq', 1000)`,
  ],
  // Step 8: count tasks. Lines are the products to count; `expected` is read from the shelves when the task is
  // submitted, never earlier, so stock that moves during counting is judged against the truth at submit time.
  [
    `CREATE TABLE count_tasks (
       id TEXT PRIMARY KEY,
       title TEXT,
       location_id TEXT NOT NULL,
       blind INTEGER NOT NULL DEFAULT 1,
       assigned_to TEXT,
       due_at TEXT,
       state TEXT NOT NULL CHECK (state IN ('open','submitted','cancelled')),
       created_by TEXT NOT NULL,
       created_at TEXT NOT NULL,
       submitted_at TEXT
     )`,
    `CREATE TABLE count_task_lines (
       task_id TEXT NOT NULL REFERENCES count_tasks(id),
       product_id TEXT NOT NULL,
       counted INTEGER,
       expected INTEGER,
       PRIMARY KEY (task_id, product_id)
     )`,
  ],  // Step 9: customers, tax and order totals. Totals are stored on the order so they never change after the fact,
  // even if the tax settings change later. Existing orders get tax 0 and customers grouped by email.
  [
    `CREATE TABLE customers (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       email TEXT COLLATE NOCASE,
       phone TEXT,
       address TEXT,
       tax_id TEXT,
       note TEXT,
       created_at TEXT NOT NULL,
       archived_at TEXT
     )`,
    `CREATE UNIQUE INDEX customers_email ON customers(email) WHERE email IS NOT NULL`,
    `ALTER TABLE orders ADD COLUMN customer_id TEXT`,
    `ALTER TABLE orders ADD COLUMN subtotal_minor INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN total_minor INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE order_lines ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX orders_customer_id ON orders(customer_id)`,
    `INSERT INTO customers(id, name, email, created_at)
       SELECT 'cus_' || lower(hex(randomblob(9))), MAX(customer_name), lower(customer_email), MIN(created_at) FROM orders WHERE customer_email IS NOT NULL GROUP BY lower(customer_email)`,
    `UPDATE orders SET customer_id = (SELECT c.id FROM customers c WHERE c.email = lower(orders.customer_email)) WHERE customer_email IS NOT NULL`,
    `UPDATE orders SET subtotal_minor = COALESCE((SELECT SUM(l.quantity * l.unit_price_minor) FROM order_lines l WHERE l.order_id = orders.id), 0)`,
    `UPDATE orders SET total_minor = subtotal_minor`,
  ],
  // Step 10: what a supplier tells us through their purchase-order link.
  [
    `ALTER TABLE purchase_orders ADD COLUMN supplier_confirmed_at TEXT`,
    `ALTER TABLE purchase_orders ADD COLUMN supplier_dispatched_at TEXT`,
    `ALTER TABLE purchase_orders ADD COLUMN supplier_note TEXT`,
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
  /** Plan limits for this business, sent by the Worker with every call. Missing means unlimited. */
  limits?: { products?: number | null; locations?: number | null; ordersPerMonth?: number | null; importsPerDay?: number | null };
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
  customer_id: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  tax_mode: TaxMode;
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
  /** Events are only recorded while the organization has a webhook; the Worker keeps this switch in sync. */
  private eventsOn = true;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.ensureDefaultLocation();
      // Events are always recorded: they feed notifications as well as webhooks. Only an explicit off (tests) stops them.
      this.eventsOn = this.one<{ value: string }>(`SELECT value FROM meta WHERE key = 'events_on'`)?.value !== '0';
    });
  }

  // ------------------------------------------------------------------ events
  private emit(type: string, data: Record<string, unknown>): void {
    if (!this.eventsOn) return;
    this.run(`INSERT INTO outbox(id, type, data, created_at) VALUES (?, ?, ?, ?)`, newId('evt'), type, JSON.stringify(data), nowIso());
    // Safety valve: if nothing is draining the outbox, do not let it grow without bound.
    if (Math.random() < 0.01) this.run(`DELETE FROM outbox WHERE created_at < ?`, new Date(Date.now() - 24 * 3600_000).toISOString());
  }

  setEventsEnabled(on: boolean): void {
    this.eventsOn = on;
    this.run(`INSERT INTO meta(key, value) VALUES ('events_on', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, on ? '1' : '0');
    if (!on) this.run(`DELETE FROM outbox`);
  }

  /** Returns up to `limit` pending events, oldest first, and removes them. */
  takeOutbox(limit: number): { id: string; type: string; data: string; createdAt: string }[] {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.all<{ seq: number; id: string; type: string; data: string; created_at: string }>(`SELECT seq, id, type, data, created_at FROM outbox ORDER BY seq ASC LIMIT ?`, Math.min(Math.max(limit, 1), 100));
      for (const r of rows) this.run(`DELETE FROM outbox WHERE seq = ?`, r.seq);
      return rows.map((r) => ({ id: r.id, type: r.type, data: r.data, createdAt: r.created_at })); // data stays a JSON string so it crosses RPC safely
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
    this.bumpStats(productId, locationId, reason, delta);
    this.emit('stock.changed', { productId, sku: product.sku, name: product.name, locationId, delta, reason, reference, balance: next });
    if (!isOut(product) && isOut(after)) this.emit('stock.out', { productId, sku: product.sku, name: product.name, onHand: after.on_hand_total });
    else if (!isLow(product) && isLow(after)) this.emit('stock.low', { productId, sku: product.sku, name: product.name, onHand: after.on_hand_total, reorderPoint: after.reorder_point });
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

  private planCheck(max: number | null | undefined, current: number, noun: string): void {
    if (max !== undefined && max !== null && current >= max) throw new Fail(403, 'plan_limit', `Your plan allows ${max} ${noun}. Ask the ShopList owner to raise it.`);
  }

  private doCreate(c: Caller, input: ProductInput): Out<{ product: Product }> {
    {
      this.planCheck(c.limits?.products, this.one<{ value: number }>(`SELECT value FROM counters WHERE name = 'products'`)?.value ?? 0, 'products');
      this.assertUnique(input.sku, input.barcode ?? null);
      const id = newId('prd');
      const now = nowIso();
      this.run(
        `INSERT INTO products(id, sku, name, description, barcode, unit, price_minor, cost_minor, reorder_point, on_hand_total, attention, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
        id, input.sku, input.name, input.description ?? null, input.barcode ?? null, input.unit, input.priceMinor, input.costMinor ?? null, input.reorderPoint ?? this.settings().defaultReorderPoint ?? null, now, now,
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
      this.emit('product.created', { productId: id, sku: input.sku, name: input.name });
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
      this.emit('product.updated', { productId: id, sku: after.sku, name: after.name, changes });
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
      this.emit('product.deleted', { productId: id, sku: before.sku, name: before.name });
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

  /** The Worker pushes a business's settings here whenever they change, so rules need no D1 read per request. */
  setSettings(settings: Record<string, unknown>): void {
    this.run(`INSERT INTO meta(key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(settings));
  }

  private settings(): { poPrefix?: string; orderPrefix?: string; defaultReorderPoint?: number | null; approvals?: ApprovalRules; timezone?: string; taxMode?: TaxMode; taxRateBp?: number } {
    try { return JSON.parse(this.one<{ value: string }>(`SELECT value FROM meta WHERE key = 'settings'`)?.value ?? '{}'); } catch { return {}; }
  }

  /** One line in the business's own activity log for each page a support session opens. */
  supportView(actor: string, requestId: string, path: string): void {
    this.audit({ actor, requestId }, 'support.view', 'support', actor, { path });
  }

  /** Granting and ending a support window are recorded in the business's own log too. */
  supportNote(actor: string, requestId: string, action: 'support.grant' | 'support.end', detail: unknown): void {
    this.audit({ actor, requestId }, action, 'support', actor, detail);
  }

  /** Final step of a scheduled deletion: every row this business ever stored, gone. */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** Numbers for the morning email: what needs attention now, and yesterday's sales in the business's own day. */
  digest(): { lowStock: number; outOfStock: number; pendingApprovals: number; unitsSold: number; salesMinor: number } {
    const n = (name: string) => this.one<{ value: number }>(`SELECT value FROM counters WHERE name = ?`, name)?.value ?? 0;
    const y = new Date(`${this.today()}T00:00:00Z`);
    y.setUTCDate(y.getUTCDate() - 1);
    const sold = this.one<{ u: number | null; m: number | null }>(`SELECT SUM(sold_qty) AS u, SUM(sold_minor) AS m FROM daily_stats WHERE day = ?`, y.toISOString().slice(0, 10));
    return { lowStock: n('low_stock'), outOfStock: n('out_of_stock'), pendingApprovals: this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM approval_requests WHERE state = 'pending'`)?.n ?? 0, unitsSold: sold?.u ?? 0, salesMinor: sold?.m ?? 0 };
  }

  /** What counts against the plan's limits. Numbers only. */
  planUsage(): { products: number; locations: number; ordersThisMonth: number; importsToday: number } {
    const n = (sql: string, ...b: SqlStorageValue[]) => this.one<{ n: number }>(sql, ...b)?.n ?? 0;
    return {
      products: this.one<{ value: number }>(`SELECT value FROM counters WHERE name = 'products'`)?.value ?? 0,
      locations: n(`SELECT COUNT(*) AS n FROM locations WHERE archived_at IS NULL`),
      ordersThisMonth: n(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`, `${nowIso().slice(0, 7)}-01T00:00:00.000Z`),
      importsToday: this.one<{ value: number }>(`SELECT value FROM counters WHERE name = ?`, `imports_${nowIso().slice(0, 10)}`)?.value ?? 0,
    };
  }

  /** Numbers only, for the platform console. Never returns product, customer or order details. */
  stats(): { products: number; locations: number; openOrders: number; orders: number; lastActivityAt: string | null } {
    const counters = Object.fromEntries(this.all<{ name: string; value: number }>(`SELECT name, value FROM counters`).map((r) => [r.name, r.value]));
    const loc = this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM locations WHERE archived_at IS NULL`)[0]?.n ?? 0;
    const open = this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE state IN ('payment_required', 'waiting_for_stock', 'ready_to_ship')`)[0]?.n ?? 0;
    const last = this.all<{ t: string | null }>(`SELECT MAX(created_at) AS t FROM audit_log`)[0]?.t ?? null;
    const orders = this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`)[0]?.n ?? 0;
    return { products: counters.products ?? 0, locations: loc, openOrders: open, orders, lastActivityAt: last };
  }

  // ---------------------------------------------------------- locations
  listLocations(): Location[] {
    return this.all<{ id: string; name: string; code: string; is_default: number; archived_at: string | null }>(`SELECT * FROM locations ORDER BY is_default DESC, name COLLATE NOCASE`).map((l) => ({
      id: l.id, name: l.name, code: l.code, isDefault: l.is_default === 1, archivedAt: l.archived_at,
    }));
  }

  createLocation(c: Caller, input: LocationInput): Result<Out<{ location: Location }>> {
    return this.tx(undefined, c, () => {
      this.planCheck(c.limits?.locations, this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM locations WHERE archived_at IS NULL`)!.n, 'locations');
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

  /** Rows for a CSV export of the activity log, oldest first. Capped, so one export cannot take the object's whole turn. */
  exportAudit(from: string, to: string, cap: number): { rows: AuditEntry[]; truncated: boolean } {
    const rows = this.all<Row>(`SELECT * FROM audit_log WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT ?`, from, to, cap + 1);
    return {
      rows: rows.slice(0, cap).map((r): AuditEntry => ({ id: r.id as string, actor: r.actor as string, action: r.action as string, entity: r.entity as string, entityId: r.entity_id as string, changes: r.changes ? JSON.parse(r.changes as string) : null, requestId: r.request_id as string, createdAt: r.created_at as string })),
      truncated: rows.length > cap,
    };
  }

  /** Deletes activity-log rows older than the cutoff, in a bounded batch. Returns how many went. */
  pruneAudit(cutoff: string): number {
    return this.ctx.storage.sql.exec(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < ? LIMIT 5000)`, cutoff).rowsWritten;
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
    // One import call is one use of the day's allowance, whatever it contains.
    const day = `imports_${nowIso().slice(0, 10)}`;
    const used = this.one<{ value: number }>(`SELECT value FROM counters WHERE name = ?`, day)?.value ?? 0;
    const max = c.limits?.importsPerDay;
    if (max !== undefined && max !== null && used >= max) return { ok: false, status: 403, code: 'plan_limit', detail: `Your plan allows ${max} imports per day. Ask the ShopList owner to raise it.` };
    this.run(`INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1`, day);
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
        locationId: r.location_id, paid: r.paid === 1, state: r.state, customerId: r.customer_id,
        totalMinor: r.total_minor, subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, taxMode: r.tax_mode,
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
      this.planCheck(c.limits?.ordersPerMonth, this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`, `${nowIso().slice(0, 7)}-01T00:00:00.000Z`)!.n, 'orders per month');
      const locationId = input.locationId ?? this.one<{ id: string }>(`SELECT id FROM locations WHERE is_default = 1 AND archived_at IS NULL`)?.id;
      if (!locationId) throw new Fail(409, 'no_default_location', 'Create a location first.');
      this.activeLocation(locationId);
      const id = newId('ord');
      const now = nowIso();
      this.run(`UPDATE counters SET value = value + 1 WHERE name = 'order_seq'`);
      const number = `${this.settings().orderPrefix ?? 'ORD-'}${this.one<{ value: number }>(`SELECT value FROM counters WHERE name = 'order_seq'`)!.value}`;
      const customerId = this.customerFor(input);
      const { taxMode, taxRateBp } = { taxMode: (this.settings().taxMode ?? 'none') as TaxMode, taxRateBp: this.settings().taxRateBp ?? 0 };
      this.run(
        `INSERT INTO orders(id, number, channel, customer_name, customer_email, country, note, location_id, paid, state, version, created_at, updated_at, customer_id, tax_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'payment_required', 1, ?, ?, ?, ?)`,
        id, number, input.channel, input.customerName, input.customerEmail ?? null, input.country ?? null, input.note ?? null, locationId, input.paid ? 1 : 0, now, now, customerId, taxMode,
      );
      let subtotal = 0;
      let tax = 0;
      const made: { quantity: number; reserved: number }[] = [];
      for (const line of input.lines) {
        const p = this.liveProduct(line.productId);
        const reserved = this.reserveUpTo(p.id, locationId, line.quantity);
        const lineMinor = line.quantity * p.price_minor;
        subtotal += lineMinor;
        tax += lineTax(taxMode, taxRateBp, lineMinor);
        this.run(`INSERT INTO order_lines(id, order_id, product_id, quantity, reserved, unit_price_minor, sku, name, open, tax_rate_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, newId('oln'), id, p.id, line.quantity, reserved, p.price_minor, p.sku, p.name, taxMode === 'none' ? 0 : taxRateBp);
        made.push({ quantity: line.quantity, reserved });
      }
      this.run(`UPDATE orders SET state = ?, subtotal_minor = ?, tax_minor = ?, total_minor = ? WHERE id = ?`, openState(input.paid, made), subtotal, tax, taxMode === 'exclusive' ? subtotal + tax : subtotal, id);
      this.audit(c, 'order.create', 'order', id, { number, customer: input.customerName, lines: input.lines.length });
      this.emit('order.created', { orderId: id, number, customerName: input.customerName, lines: input.lines.length });
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
        this.bumpStats(l.product_id, row.location_id, 'revenue', l.quantity * l.unit_price_minor);
        this.run(`UPDATE order_lines SET open = 0 WHERE id = ?`, l.id);
      }
      this.run(`UPDATE orders SET state = 'shipped', shipped_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), id);
      this.audit(c, 'order.ship', 'order', id, { number: row.number });
      this.emit('order.shipped', { orderId: id, number: row.number, customerName: row.customer_name });
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
      this.emit('order.cancelled', { orderId: id, number: row.number, customerName: row.customer_name });
      return { status: 200, body: { order: this.orderViews([this.orderRow(id)])[0] } };
    });
  }

  // ---------------------------------------------------------- approvals
  private rules(): ApprovalRules {
    const saved = this.settings().approvals;
    return saved ? { ...APPROVAL_DEFAULTS, ...saved } : APPROVAL_DEFAULTS;
  }

  private approvalView(r: Row): ApprovalView {
    return {
      id: r.id as string, kind: r.kind as ApprovalView['kind'], summary: r.summary as string, requestedBy: r.requested_by as string,
      state: r.state as ApprovalView['state'], decidedBy: (r.decided_by as string) ?? null, note: (r.note as string) ?? null,
      createdAt: r.created_at as string, decidedAt: (r.decided_at as string) ?? null, expiresAt: r.expires_at as string,
    };
  }

  private expireOld(): void {
    this.run(`UPDATE approval_requests SET state = 'expired' WHERE state = 'pending' AND expires_at < ?`, nowIso());
  }

  /**
   * Called for people who cannot approve. If a rule says this action needs a second pair of eyes, the exact input is
   * stored and returned as a pending request; otherwise null and the caller goes ahead. Asking twice for the same
   * thing returns the request that is already waiting.
   */
  checkApproval(c: Caller, kind: ApprovalView['kind'], payload: Record<string, unknown>): ApprovalView | null {
    const rules = this.rules();
    let summary: string | null = null;
    if (kind === 'movement') {
      const m = payload as unknown as MovementInput;
      const p = this.liveProduct(m.productId);
      const units = Math.abs(m.delta);
      if (rules.damage.on && m.reason === 'damage') summary = `Write off ${units} × ${p.name} as damaged`;
      else if (rules.largeAdjustment.on && m.delta < 0 && (m.reason === 'adjust' || m.reason === 'damage') &&
        (units > rules.largeAdjustment.units || (p.cost_minor !== null && units * p.cost_minor > rules.largeAdjustment.valueMinor))) summary = `Reduce ${p.name} by ${units} (${m.reason})`;
    } else if (kind === 'count') {
      const m = payload as unknown as CountInput;
      const p = this.liveProduct(m.productId);
      const have = this.one<{ on_hand: number }>(`SELECT on_hand FROM stock_levels WHERE product_id = ? AND location_id = ?`, m.productId, m.locationId)?.on_hand ?? 0;
      const diff = m.counted - have;
      if (rules.countVariance.on && Math.abs(diff) > rules.countVariance.units) summary = `Count of ${p.name}: ${m.counted} on the shelf, system says ${have} (${diff > 0 ? '+' : ''}${diff})`;
    } else if (kind === 'cancel_order') {
      const o = this.orderRow(String(payload.orderId));
      if (rules.cancelPaid.on && o.paid === 1) summary = `Cancel paid order ${o.number} for ${o.customer_name}`;
    } else if (kind === 'price_drop') {
      const p = this.liveProduct(String(payload.productId));
      const next = (payload.patch as { priceMinor?: number }).priceMinor;
      if (rules.priceDrop.on && typeof next === 'number' && p.price_minor > 0 && ((p.price_minor - next) * 100) / p.price_minor > rules.priceDrop.percent) {
        summary = `Lower the price of ${p.name} from ${(p.price_minor / 100).toFixed(2)} to ${(next / 100).toFixed(2)}`;
      }
    }
    if (!summary) return null;
    const json = JSON.stringify(payload);
    const same = this.one<Row>(`SELECT * FROM approval_requests WHERE state = 'pending' AND requested_by = ? AND kind = ? AND payload = ?`, c.actor, kind, json);
    if (same) return this.approvalView(same);
    const id = newId('apr');
    const now = nowIso();
    this.run(`INSERT INTO approval_requests(id, kind, payload, summary, requested_by, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`, id, kind, json, summary, c.actor, now, new Date(Date.now() + 7 * 86400_000).toISOString());
    this.audit(c, 'approval.request', 'approval', id, { kind, summary });
    this.emit('approval.requested', { approvalId: id, summary, requestedBy: c.actor });
    return this.approvalView(this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id)!);
  }

  listApprovals(q: { state?: string; requestedBy?: string; limit: number }): ApprovalView[] {
    this.expireOld();
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (q.state) { where.push('state = ?'); args.push(q.state); }
    if (q.requestedBy) { where.push('requested_by = ?'); args.push(q.requestedBy); }
    return this.all<Row>(`SELECT * FROM approval_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...args, q.limit).map((r) => this.approvalView(r));
  }

  pendingApprovalCount(): number {
    this.expireOld();
    return this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM approval_requests WHERE state = 'pending'`)?.n ?? 0;
  }

  /** Approve applies the stored input through the normal code path, checked against today's data. Reject needs a note. */
  decideApproval(c: Caller, id: string, approve: boolean, note: string | null): Result<{ approval: ApprovalView }> {
    this.expireOld();
    const r = this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id);
    const fail = (status: number, code: string, detail: string): Result<{ approval: ApprovalView }> => ({ ok: false, status, code, detail });
    if (!r) return fail(404, 'approval_not_found', 'That request does not exist.');
    if (r.state !== 'pending') return fail(409, 'approval_closed', `That request is already ${r.state}.`);
    if (r.requested_by === c.actor) return fail(403, 'self_approval', 'You cannot approve your own request.');
    const now = nowIso();
    if (!approve) {
      if (!note) return fail(400, 'note_required', 'Say why you are rejecting it.');
      this.run(`UPDATE approval_requests SET state = 'rejected', decided_by = ?, note = ?, decided_at = ? WHERE id = ?`, c.actor, note, now, id);
      this.audit(c, 'approval.reject', 'approval', id, { summary: r.summary, requestedBy: r.requested_by, note });
      this.emit('approval.decided', { approvalId: id, summary: r.summary, requestedBy: r.requested_by, approved: false, note });
      return ok({ approval: this.approvalView(this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id)!) });
    }
    // The change is made as the person who asked, so the ledger shows them; the approval is recorded as the approver.
    const asRequester: Caller = { actor: r.requested_by as string, requestId: c.requestId };
    const idem: Idem = { key: `approval:${id}`, hash: id };
    const payload = JSON.parse(r.payload as string) as Record<string, any>;
    let result: Result<unknown>;
    switch (r.kind) {
      case 'movement': result = this.addMovement(asRequester, idem, payload as MovementInput); break;
      case 'count': result = this.count(asRequester, idem, payload as CountInput); break;
      case 'cancel_order': result = this.cancelOrder(asRequester, String(payload.orderId), Number(payload.version)); break;
      case 'price_drop': result = this.updateProduct(asRequester, idem, String(payload.productId), Number(payload.version), payload.patch as ProductPatch); break;
      default: result = { ok: false, status: 400, code: 'unknown_kind', detail: 'Unknown request type.' };
    }
    if (!result.ok) {
      this.run(`UPDATE approval_requests SET state = 'failed', decided_by = ?, note = ?, decided_at = ? WHERE id = ?`, c.actor, result.detail, now, id);
      this.emit('approval.decided', { approvalId: id, summary: r.summary, requestedBy: r.requested_by, approved: false, note: `Could not be applied: ${result.detail}` });
      return ok({ approval: this.approvalView(this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id)!) });
    }
    this.run(`UPDATE approval_requests SET state = 'applied', decided_by = ?, note = ?, decided_at = ? WHERE id = ?`, c.actor, note, now, id);
    this.audit(c, 'approval.approve', 'approval', id, { summary: r.summary, requestedBy: r.requested_by, note });
    this.emit('approval.decided', { approvalId: id, summary: r.summary, requestedBy: r.requested_by, approved: true, note });
    return ok({ approval: this.approvalView(this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id)!) });
  }

  withdrawApproval(c: Caller, id: string): Result<{ approval: ApprovalView }> {
    const r = this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id);
    if (!r || r.requested_by !== c.actor) return { ok: false, status: 404, code: 'approval_not_found', detail: 'That request does not exist.' };
    if (r.state !== 'pending') return { ok: false, status: 409, code: 'approval_closed', detail: `That request is already ${r.state}.` };
    this.run(`UPDATE approval_requests SET state = 'withdrawn', decided_at = ? WHERE id = ?`, nowIso(), id);
    return ok({ approval: this.approvalView(this.one<Row>(`SELECT * FROM approval_requests WHERE id = ?`, id)!) });
  }

  // ---------------------------------------------------------- purchasing
  private supplierView(r: Row): Supplier {
    return { id: r.id as string, name: r.name as string, email: (r.email as string) ?? null, phone: (r.phone as string) ?? null, leadTimeDays: (r.lead_time_days as number) ?? null, note: (r.note as string) ?? null, archivedAt: (r.archived_at as string) ?? null, createdAt: r.created_at as string };
  }

  listSuppliers(): Supplier[] {
    return this.all<Row>(`SELECT * FROM suppliers ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE`).map((r) => this.supplierView(r));
  }

  createSupplier(c: Caller, input: SupplierInput): Result<Out<{ supplier: Supplier }>> {
    return this.tx(undefined, c, () => {
      const id = newId('sup');
      this.run(`INSERT INTO suppliers(id, name, email, phone, lead_time_days, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, input.name, input.email || null, input.phone ?? null, input.leadTimeDays ?? null, input.note ?? null, nowIso());
      this.audit(c, 'supplier.create', 'supplier', id, { name: input.name });
      return { status: 201, body: { supplier: this.supplierView(this.one<Row>(`SELECT * FROM suppliers WHERE id = ?`, id)!) } };
    });
  }

  updateSupplier(c: Caller, id: string, patch: Partial<SupplierInput> & { archived?: boolean }): Result<Out<{ supplier: Supplier }>> {
    return this.tx(undefined, c, () => {
      const cur = this.one<Row>(`SELECT * FROM suppliers WHERE id = ?`, id);
      if (!cur) throw new Fail(404, 'supplier_not_found', 'That supplier does not exist.');
      this.run(
        `UPDATE suppliers SET name = ?, email = ?, phone = ?, lead_time_days = ?, note = ?, archived_at = ? WHERE id = ?`,
        patch.name ?? (cur.name as string), patch.email !== undefined ? patch.email || null : (cur.email as string | null), patch.phone !== undefined ? patch.phone : (cur.phone as string | null),
        patch.leadTimeDays !== undefined ? patch.leadTimeDays : (cur.lead_time_days as number | null), patch.note !== undefined ? patch.note : (cur.note as string | null),
        patch.archived === undefined ? (cur.archived_at as string | null) : patch.archived ? nowIso() : null, id,
      );
      this.audit(c, 'supplier.update', 'supplier', id, patch);
      return { status: 200, body: { supplier: this.supplierView(this.one<Row>(`SELECT * FROM suppliers WHERE id = ?`, id)!) } };
    });
  }

  private poRow(id: string): Row {
    const r = this.one<Row>(`SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`, id);
    if (!r) throw new Fail(404, 'po_not_found', 'That purchase order does not exist.');
    return r;
  }

  private poViews(rows: Row[]): PurchaseOrder[] {
    if (!rows.length) return [];
    const marks = rows.map(() => '?').join(',');
    const lines = this.all<Row>(`SELECT l.*, p.sku, p.name FROM po_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id IN (${marks}) ORDER BY l.rowid`, ...rows.map((r) => r.id as string));
    return rows.map((r) => {
      const ls = lines.filter((l) => l.po_id === r.id).map((l) => ({ id: l.id as string, productId: l.product_id as string, sku: l.sku as string, name: l.name as string, quantity: l.quantity as number, received: l.received as number, unitCostMinor: l.unit_cost_minor as number }));
      return {
        id: r.id as string, number: r.number as string, supplierId: r.supplier_id as string, supplierName: r.supplier_name as string, locationId: r.location_id as string, state: r.state as PoState,
        expectedAt: (r.expected_at as string) ?? null, note: (r.note as string) ?? null, createdBy: r.created_by as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string, version: r.version as number,
        lines: ls, totalCostMinor: ls.reduce((a, l) => a + l.quantity * l.unitCostMinor, 0),
        supplierConfirmedAt: (r.supplier_confirmed_at as string) ?? null, supplierDispatchedAt: (r.supplier_dispatched_at as string) ?? null, supplierNote: (r.supplier_note as string) ?? null,
      };
    });
  }

  listPurchaseOrders(q: { state?: string; limit: number }): PurchaseOrder[] {
    const rows = this.all<Row>(`SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${q.state ? 'WHERE po.state = ?' : ''} ORDER BY po.created_at DESC LIMIT ?`, ...(q.state ? [q.state] : []), q.limit);
    return this.poViews(rows);
  }

  getPurchaseOrder(id: string): Result<{ order: PurchaseOrder }> {
    try { return ok({ order: this.poViews([this.poRow(id)])[0] }); } catch (e) { if (e instanceof Fail) return { ok: false, status: e.status, code: e.code, detail: e.detail }; throw e; }
  }

  /** Exactly what a supplier may see of a purchase order: no internal ids, no staff, no other orders. */
  publicPo(id: string): Result<{ po: { number: string; state: PoState; expectedAt: string | null; note: string | null; supplierName: string; createdAt: string; confirmedAt: string | null; dispatchedAt: string | null; supplierNote: string | null; lines: { sku: string; name: string; quantity: number; received: number; unitCostMinor: number }[]; totalMinor: number } }> {
    const r = this.getPurchaseOrder(id);
    if (!r.ok) return r;
    const o = r.value.order;
    return ok({ po: { number: o.number, state: o.state, expectedAt: o.expectedAt, note: o.note, supplierName: o.supplierName, createdAt: o.createdAt, confirmedAt: o.supplierConfirmedAt ?? null, dispatchedAt: o.supplierDispatchedAt ?? null, supplierNote: o.supplierNote ?? null, lines: o.lines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, received: l.received, unitCostMinor: l.unitCostMinor })), totalMinor: o.totalCostMinor } });
  }

  /** The supplier clicks Confirm or Mark dispatched. Only an open purchase order can be answered, and repeating a click changes nothing. */
  supplierAct(requestId: string, id: string, act: 'confirm' | 'dispatch', note: string | null): Result<Out<{ ok: true }>> {
    return this.tx(undefined, { actor: 'supplier', requestId }, () => {
      const po = this.poRow(id);
      if (po.state !== 'sent' && po.state !== 'partially_received') throw new Fail(409, 'po_closed', 'This purchase order is no longer open. Please contact the buyer.');
      const col = act === 'confirm' ? 'supplier_confirmed_at' : 'supplier_dispatched_at';
      if (po[col]) return { status: 200, body: { ok: true as const } };
      this.run(`UPDATE purchase_orders SET ${col} = ?, supplier_note = COALESCE(?, supplier_note), version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), note, nowIso(), id);
      this.audit({ actor: 'supplier', requestId }, act === 'confirm' ? 'po.supplier_confirm' : 'po.supplier_dispatch', 'purchase_order', id, { number: po.number });
      this.emit('po.supplier', { number: po.number, supplier: po.supplier_name, action: act, note });
      return { status: 200, body: { ok: true as const } };
    });
  }

  /** What a customer may see of an order: no cost, no staff, no internal note, no contact details. */
  publicOrder(id: string): Result<{ order: { number: string; state: OrderState; paid: boolean; createdAt: string; shippedAt: string | null; taxMode: string; subtotalMinor: number; taxMinor: number; totalMinor: number; lines: { name: string; quantity: number; unitPriceMinor: number; lineMinor: number }[] } }> {
    const d = this.orderDocument(id);
    if (!d.ok) return d;
    const { order, lines } = d.value;
    return ok({ order: { number: order.number, state: order.state, paid: order.paid, createdAt: order.createdAt, shippedAt: order.shippedAt, taxMode: order.taxMode, subtotalMinor: order.subtotalMinor, taxMinor: order.taxMinor, totalMinor: order.totalMinor, lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineMinor: l.lineMinor })) } });
  }

  /** Units ordered and not yet received, per product, across open purchase orders. */
  onOrder(): Record<string, number> {
    return Object.fromEntries(this.all<{ product_id: string; n: number }>(
      `SELECT l.product_id, SUM(l.quantity - l.received) AS n FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id WHERE po.state IN ('sent','partially_received') GROUP BY l.product_id`,
    ).map((r) => [r.product_id, r.n]));
  }

  private writePoLines(poId: string, lines: PurchaseOrderInput['lines']): void {
    this.run(`DELETE FROM po_lines WHERE po_id = ?`, poId);
    for (const l of lines) {
      this.liveProduct(l.productId);
      this.run(`INSERT INTO po_lines(id, po_id, product_id, quantity, received, unit_cost_minor) VALUES (?, ?, ?, ?, 0, ?)`, newId('pol'), poId, l.productId, l.quantity, l.unitCostMinor);
    }
  }

  createPurchaseOrder(c: Caller, input: PurchaseOrderInput): Result<Out<{ order: PurchaseOrder }>> {
    return this.tx(undefined, c, () => {
      const sup = this.one<Row>(`SELECT archived_at FROM suppliers WHERE id = ?`, input.supplierId);
      if (!sup || sup.archived_at) throw new Fail(404, 'supplier_not_found', 'Choose an active supplier.');
      this.activeLocation(input.locationId);
      this.run(`UPDATE counters SET value = value + 1 WHERE name = 'po_seq'`);
      const number = `${this.settings().poPrefix ?? 'PO-'}${this.one<{ value: number }>(`SELECT value FROM counters WHERE name = 'po_seq'`)!.value}`;
      const id = newId('po');
      const now = nowIso();
      this.run(`INSERT INTO purchase_orders(id, number, supplier_id, location_id, state, expected_at, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`, id, number, input.supplierId, input.locationId, input.expectedAt ?? null, input.note ?? null, c.actor, now, now);
      this.writePoLines(id, input.lines);
      this.audit(c, 'po.create', 'purchase_order', id, { number, lines: input.lines.length });
      return { status: 201, body: { order: this.poViews([this.poRow(id)])[0] } };
    });
  }

  updatePurchaseOrder(c: Caller, id: string, version: number, patch: Partial<PurchaseOrderInput>): Result<Out<{ order: PurchaseOrder }>> {
    return this.tx(undefined, c, () => {
      const po = this.poRow(id);
      if (po.version !== version) throw new Fail(412, 'version_conflict', 'This purchase order changed. Reload and try again.');
      if (po.state !== 'draft') throw new Fail(409, 'po_not_draft', 'Only a draft can be edited.');
      if (patch.supplierId) { const sup = this.one<Row>(`SELECT archived_at FROM suppliers WHERE id = ?`, patch.supplierId); if (!sup || sup.archived_at) throw new Fail(404, 'supplier_not_found', 'Choose an active supplier.'); }
      if (patch.locationId) this.activeLocation(patch.locationId);
      this.run(`UPDATE purchase_orders SET supplier_id = ?, location_id = ?, expected_at = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        patch.supplierId ?? (po.supplier_id as string), patch.locationId ?? (po.location_id as string), patch.expectedAt !== undefined ? patch.expectedAt : (po.expected_at as string | null), patch.note !== undefined ? patch.note : (po.note as string | null), nowIso(), id);
      if (patch.lines) this.writePoLines(id, patch.lines);
      this.audit(c, 'po.update', 'purchase_order', id, { number: po.number });
      return { status: 200, body: { order: this.poViews([this.poRow(id)])[0] } };
    });
  }

  private poMove(c: Caller, id: string, from: PoState[], to: PoState, action: string): Result<Out<{ order: PurchaseOrder }>> {
    return this.tx(undefined, c, () => {
      const po = this.poRow(id);
      if (!from.includes(po.state as PoState)) throw new Fail(409, 'po_state', `A purchase order that is ${String(po.state).replace('_', ' ')} cannot do that.`);
      const received = this.one<{ n: number }>(`SELECT COALESCE(SUM(received), 0) AS n FROM po_lines WHERE po_id = ?`, id)!.n;
      if (to === 'cancelled' && received > 0) throw new Fail(409, 'po_has_receipts', 'Some of it has arrived. Close the rest instead of cancelling.');
      this.run(`UPDATE purchase_orders SET state = ?, version = version + 1, updated_at = ? WHERE id = ?`, to, nowIso(), id);
      this.audit(c, action, 'purchase_order', id, { number: po.number });
      return { status: 200, body: { order: this.poViews([this.poRow(id)])[0] } };
    });
  }

  sendPurchaseOrder(c: Caller, id: string) { return this.poMove(c, id, ['draft'], 'sent', 'po.send'); }
  cancelPurchaseOrder(c: Caller, id: string) { return this.poMove(c, id, ['draft', 'sent'], 'cancelled', 'po.cancel'); }
  closePurchaseOrder(c: Caller, id: string) { return this.poMove(c, id, ['partially_received'], 'closed', 'po.close'); }

  /** Receiving writes real receive movements at the order's location, sets each product's cost to what was paid, and is all-or-nothing. */
  receivePurchaseOrder(c: Caller, idem: Idem | undefined, id: string, input: ReceiveInput): Result<Out<{ order: PurchaseOrder }>> {
    return this.tx(idem, c, () => {
      const po = this.poRow(id);
      if (po.state !== 'sent' && po.state !== 'partially_received') throw new Fail(409, 'po_state', 'Only a sent order can be received.');
      const seen = new Set<string>();
      for (const r of input.lines) {
        if (seen.has(r.lineId)) throw new Fail(400, 'duplicate_line', 'Each line can appear once per receipt.');
        seen.add(r.lineId);
        const line = this.one<Row>(`SELECT * FROM po_lines WHERE id = ? AND po_id = ?`, r.lineId, id);
        if (!line) throw new Fail(404, 'po_line_not_found', 'That line is not on this order.');
        const left = (line.quantity as number) - (line.received as number);
        if (r.quantity > left) throw new Fail(409, 'over_receipt', `Only ${left} more ${left === 1 ? 'is' : 'are'} expected on that line.`, { errors: [{ field: 'quantity', code: 'over_receipt' }] });
        const before = this.liveProduct(line.product_id as string);
        // Cost follows the latest purchase price; keep the value counters exact.
        this.run(`UPDATE products SET cost_minor = ? WHERE id = ?`, line.unit_cost_minor as number, before.id);
        this.applyCounters(before, { ...before, cost_minor: line.unit_cost_minor as number });
        this.move(c, before.id, po.location_id as string, r.quantity, 'receive', po.number as string, null);
        this.run(`UPDATE po_lines SET received = received + ? WHERE id = ?`, r.quantity, r.lineId);
      }
      const open = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM po_lines WHERE po_id = ? AND received < quantity`, id)!.n;
      this.run(`UPDATE purchase_orders SET state = ?, version = version + 1, updated_at = ? WHERE id = ?`, open ? 'partially_received' : 'received', nowIso(), id);
      this.audit(c, 'po.receive', 'purchase_order', id, { number: po.number, lines: input.lines.length });
      this.emit('po.received', { poId: id, number: po.number, complete: !open });
      return { status: 200, body: { order: this.poViews([this.poRow(id)])[0] } };
    });
  }

  /**
   * What to order. Available stock plus what is already on order is compared with the reorder point and with how fast
   * the product sells. Suggested quantity covers the supplier's lead time plus `coverDays` of sales. The usual supplier
   * is whoever the product was last ordered from.
   */
  reorderSuggestions(coverDays = 14): { productId: string; sku: string; name: string; available: number; onOrder: number; reorderPoint: number | null; avgDaily: number; daysOfCover: number | null; suggested: number; unitCostMinor: number; supplierId: string | null; supplierName: string | null; leadTimeDays: number }[] {
    const onOrder = this.onOrder();
    const since = new Date(Date.parse(this.today()) - 29 * 86400_000).toISOString().slice(0, 10);
    const rows = this.all<Row>(
      `SELECT p.id, p.sku, p.name, p.reorder_point, p.cost_minor,
              p.on_hand_total - COALESCE((SELECT SUM(reserved) FROM stock_levels WHERE product_id = p.id), 0) AS available,
              COALESCE((SELECT SUM(d.sold_qty) FROM daily_stats d WHERE d.product_id = p.id AND d.day >= ?), 0) AS sold30,
              (SELECT po.supplier_id FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id WHERE l.product_id = p.id AND po.state <> 'cancelled' ORDER BY po.created_at DESC LIMIT 1) AS supplier_id,
              (SELECT l.unit_cost_minor FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id WHERE l.product_id = p.id AND po.state <> 'cancelled' ORDER BY po.created_at DESC LIMIT 1) AS last_cost
         FROM products p WHERE p.deleted_at IS NULL`, since);
    const sup = new Map(this.all<Row>(`SELECT id, name, lead_time_days FROM suppliers WHERE archived_at IS NULL`).map((r) => [r.id as string, r]));
    const out = [];
    for (const r of rows) {
      const avgDaily = Number(r.sold30) / 30;
      const have = Number(r.available) + (onOrder[r.id as string] ?? 0);
      const rp = (r.reorder_point as number | null) ?? null;
      const s = r.supplier_id ? sup.get(r.supplier_id as string) : undefined;
      const lead = Number(s?.lead_time_days ?? 7);
      const cover = avgDaily > 0 ? Number(r.available) / avgDaily : null;
      const low = rp !== null && have <= rp;
      const soon = cover !== null && cover < lead && have <= avgDaily * (lead + coverDays);
      if (!low && !soon) continue;
      const wanted = avgDaily > 0 ? Math.ceil(avgDaily * (lead + coverDays) - have) : (rp ?? 0) - have;
      if (!low && wanted <= 0) continue; // already covered by what is on the way
      const suggested = Math.max(1, Math.ceil(wanted), low && rp !== null ? rp - have + 1 : 0);
      out.push({ productId: r.id as string, sku: r.sku as string, name: r.name as string, available: Number(r.available), onOrder: onOrder[r.id as string] ?? 0, reorderPoint: rp, avgDaily: Math.round(avgDaily * 100) / 100, daysOfCover: cover === null ? null : Math.floor(cover), suggested, unitCostMinor: Number(r.last_cost ?? r.cost_minor ?? 0), supplierId: s ? (r.supplier_id as string) : null, supplierName: s ? (s.name as string) : null, leadTimeDays: lead });
    }
    return out.sort((a, b) => (a.daysOfCover ?? 9999) - (b.daysOfCover ?? 9999) || a.name.localeCompare(b.name)).slice(0, 500);
  }

  // ---------------------------------------------------------- customers
  /** Which customer an order belongs to: the one chosen, or the one with that email (made on first use). Name-only orders stay unlinked. */
  private customerFor(input: { customerId?: string | null; customerName: string; customerEmail?: string | null }): string | null {
    if (input.customerId) {
      const c = this.one<Row>(`SELECT archived_at FROM customers WHERE id = ?`, input.customerId);
      if (!c || c.archived_at) throw new Fail(404, 'customer_not_found', 'That customer does not exist.');
      return input.customerId;
    }
    const email = input.customerEmail?.trim().toLowerCase();
    if (!email) return null;
    const hit = this.one<{ id: string }>(`SELECT id FROM customers WHERE email = ?`, email);
    if (hit) return hit.id;
    const id = newId('cus');
    this.run(`INSERT INTO customers(id, name, email, created_at) VALUES (?, ?, ?, ?)`, id, input.customerName, email, nowIso());
    return id;
  }

  private customerView(r: Row): Customer {
    return {
      id: r.id as string, name: r.name as string, email: (r.email as string) ?? null, phone: (r.phone as string) ?? null, address: (r.address as string) ?? null, taxId: (r.tax_id as string) ?? null, note: (r.note as string) ?? null,
      archivedAt: (r.archived_at as string) ?? null, createdAt: r.created_at as string, orders: Number(r.orders ?? 0), spentMinor: Number(r.spent ?? 0), lastOrderAt: (r.last_order as string) ?? null,
    };
  }

  private customerRows(where: string, ...args: SqlStorageValue[]): Row[] {
    return this.all<Row>(
      `SELECT c.*, COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.state <> 'cancelled' THEN o.total_minor ELSE 0 END), 0) AS spent, MAX(o.created_at) AS last_order
         FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ${where} GROUP BY c.id ORDER BY MAX(o.created_at) IS NULL, MAX(o.created_at) DESC, c.name COLLATE NOCASE LIMIT 200`, ...args);
  }

  listCustomers(q?: string): Customer[] {
    if (q?.trim()) {
      const like = `%${q.trim().replace(/[%_]/g, '')}%`;
      return this.customerRows(`WHERE c.archived_at IS NULL AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)`, like, like, like).map((r) => this.customerView(r));
    }
    return this.customerRows(`WHERE c.archived_at IS NULL`).map((r) => this.customerView(r));
  }

  getCustomer(id: string): Result<{ customer: Customer; orders: { id: string; number: string; state: string; totalMinor: number; createdAt: string }[] }> {
    const r = this.customerRows(`WHERE c.id = ?`, id)[0];
    if (!r) return { ok: false, status: 404, code: 'customer_not_found', detail: 'That customer does not exist.' };
    const orders = this.all<Row>(`SELECT id, number, state, total_minor, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`, id)
      .map((o) => ({ id: o.id as string, number: o.number as string, state: o.state as string, totalMinor: o.total_minor as number, createdAt: o.created_at as string }));
    return ok({ customer: this.customerView(r), orders });
  }

  createCustomer(c: Caller, input: CustomerInput): Result<Out<{ customer: Customer }>> {
    return this.tx(undefined, c, () => {
      const email = input.email ? input.email.toLowerCase() : null;
      if (email && this.one(`SELECT 1 FROM customers WHERE email = ?`, email)) throw new Fail(409, 'customer_exists', 'A customer with that email already exists.');
      const id = newId('cus');
      this.run(`INSERT INTO customers(id, name, email, phone, address, tax_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, input.name, email, input.phone ?? null, input.address ?? null, input.taxId ?? null, input.note ?? null, nowIso());
      this.audit(c, 'customer.create', 'customer', id, { name: input.name });
      return { status: 201, body: { customer: this.customerView(this.customerRows(`WHERE c.id = ?`, id)[0]) } };
    });
  }

  updateCustomer(c: Caller, id: string, patch: Partial<CustomerInput> & { archived?: boolean }): Result<Out<{ customer: Customer }>> {
    return this.tx(undefined, c, () => {
      const cur = this.one<Row>(`SELECT * FROM customers WHERE id = ?`, id);
      if (!cur) throw new Fail(404, 'customer_not_found', 'That customer does not exist.');
      const email = patch.email !== undefined ? (patch.email ? patch.email.toLowerCase() : null) : (cur.email as string | null);
      if (email && email !== cur.email && this.one(`SELECT 1 FROM customers WHERE email = ? AND id <> ?`, email, id)) throw new Fail(409, 'customer_exists', 'A customer with that email already exists.');
      this.run(`UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, tax_id = ?, note = ?, archived_at = ? WHERE id = ?`,
        patch.name ?? (cur.name as string), email, patch.phone !== undefined ? patch.phone : (cur.phone as string | null), patch.address !== undefined ? patch.address : (cur.address as string | null),
        patch.taxId !== undefined ? patch.taxId : (cur.tax_id as string | null), patch.note !== undefined ? patch.note : (cur.note as string | null),
        patch.archived === undefined ? (cur.archived_at as string | null) : patch.archived ? nowIso() : null, id);
      this.audit(c, 'customer.update', 'customer', id, patch);
      return { status: 200, body: { customer: this.customerView(this.customerRows(`WHERE c.id = ?`, id)[0]) } };
    });
  }

  /** Everything a printed invoice or receipt needs, with tax worked out per line the way the order was priced. */
  orderDocument(id: string): Result<{ order: Order; customer: Customer | null; lines: { name: string; sku: string; quantity: number; unitPriceMinor: number; taxRateBp: number; lineMinor: number; taxMinor: number }[] }> {
    const row = this.one<OrderRow>(`SELECT * FROM orders WHERE id = ?`, id);
    if (!row) return { ok: false, status: 404, code: 'order_not_found', detail: 'That order does not exist.' };
    const order = this.orderViews([row])[0];
    const lines = this.all<LineRow & { tax_rate_bp: number }>(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY id`, id).map((l) => {
      const lineMinor = l.quantity * l.unit_price_minor;
      return { name: l.name, sku: l.sku, quantity: l.quantity, unitPriceMinor: l.unit_price_minor, taxRateBp: l.tax_rate_bp, lineMinor, taxMinor: lineTax(row.tax_mode, l.tax_rate_bp, lineMinor) };
    });
    const cust = row.customer_id ? this.customerRows(`WHERE c.id = ?`, row.customer_id)[0] : undefined;
    return ok({ order, customer: cust ? this.customerView(cust) : null, lines });
  }

  // ---------------------------------------------------------- count tasks
  private taskView(r: Row, showExpected: boolean): CountTask {
    const lines = this.all<Row>(
      `SELECT l.product_id, l.counted, l.expected, p.sku, p.name FROM count_task_lines l JOIN products p ON p.id = l.product_id WHERE l.task_id = ? ORDER BY p.name COLLATE NOCASE`, r.id as string,
    ).map((l) => {
      // Blind counting: the counter does not see what the system expects, until the task is submitted.
      const live = r.state === 'open' ? (this.one<{ n: number }>(`SELECT COALESCE(on_hand, 0) AS n FROM stock_levels WHERE product_id = ? AND location_id = ?`, l.product_id as string, r.location_id as string)?.n ?? 0) : null;
      const expected = r.state === 'submitted' ? ((l.expected as number | null) ?? null) : showExpected || !r.blind ? live : null;
      return { productId: l.product_id as string, sku: l.sku as string, name: l.name as string, counted: (l.counted as number | null) ?? null, expected };
    });
    const counted = lines.filter((l) => l.counted !== null).length;
    return {
      id: r.id as string, title: (r.title as string) ?? null, locationId: r.location_id as string, blind: r.blind === 1, assignedTo: (r.assigned_to as string) ?? null, dueAt: (r.due_at as string) ?? null,
      state: r.state as CountTask['state'], createdBy: r.created_by as string, createdAt: r.created_at as string, submittedAt: (r.submitted_at as string) ?? null, lines,
      summary: { total: lines.length, counted, variances: lines.filter((l) => l.counted !== null && l.expected !== null && l.counted !== l.expected).length },
    };
  }

  createCountTask(c: Caller, input: CountTaskInput): Result<Out<{ task: CountTask }>> {
    return this.tx(undefined, c, () => {
      this.activeLocation(input.locationId);
      let ids: string[];
      const sc = input.scope;
      if (sc.kind === 'list') ids = sc.productIds.filter((id) => this.one(`SELECT 1 FROM products WHERE id = ? AND deleted_at IS NULL`, id));
      else if (sc.kind === 'tag') ids = this.all<{ id: string }>(`SELECT p.id FROM products p JOIN product_tags t ON t.product_id = p.id WHERE p.deleted_at IS NULL AND t.tag = ? LIMIT 500`, sc.tag.toLowerCase()).map((r) => r.id);
      else if (sc.kind === 'stale') {
        const cutoff = new Date(Date.now() - sc.days * 86400_000).toISOString();
        ids = this.all<{ id: string }>(`SELECT p.id FROM products p WHERE p.deleted_at IS NULL AND COALESCE((SELECT MAX(m.created_at) FROM stock_movements m WHERE m.product_id = p.id AND m.location_id = ? AND m.reason = 'count'), '') < ? ORDER BY p.name LIMIT 500`, input.locationId, cutoff).map((r) => r.id);
      } else ids = this.all<{ id: string }>(`SELECT id FROM products WHERE deleted_at IS NULL ORDER BY name LIMIT 500`).map((r) => r.id);
      if (!ids.length) throw new Fail(409, 'nothing_to_count', 'No products match that selection.');
      const id = newId('cnt');
      this.run(`INSERT INTO count_tasks(id, title, location_id, blind, assigned_to, due_at, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`, id, input.title ?? null, input.locationId, input.blind ? 1 : 0, input.assignedTo ?? null, input.dueAt ?? null, c.actor, nowIso());
      for (const pid of [...new Set(ids)]) this.run(`INSERT INTO count_task_lines(task_id, product_id) VALUES (?, ?)`, id, pid);
      this.audit(c, 'count_task.create', 'count_task', id, { lines: ids.length, assignedTo: input.assignedTo ?? null });
      if (input.assignedTo) this.emit('count.assigned', { taskId: id, assignedTo: input.assignedTo, title: input.title ?? 'stock count', dueAt: input.dueAt ?? null });
      return { status: 201, body: { task: this.taskView(this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id)!, true) } };
    });
  }

  /** `mine` limits to tasks given to that person or to nobody in particular. Counters never see expected quantities on blind tasks. */
  listCountTasks(q: { mine?: string; state?: string; limit: number }): Omit<CountTask, 'lines'>[] {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    if (q.state) { where.push('state = ?'); args.push(q.state); }
    if (q.mine) { where.push('(assigned_to = ? OR assigned_to IS NULL)'); args.push(q.mine); }
    return this.all<Row>(`SELECT * FROM count_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...args, q.limit).map((r) => {
      const { lines: _l, ...rest } = this.taskView(r, false);
      return rest;
    });
  }

  getCountTask(id: string, asManager: boolean): Result<{ task: CountTask }> {
    const r = this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id);
    if (!r) return { ok: false, status: 404, code: 'count_task_not_found', detail: 'That count does not exist.' };
    return ok({ task: this.taskView(r, asManager) });
  }

  saveCountLines(c: Caller, id: string, lines: { productId: string; counted: number }[]): Result<Out<{ task: CountTask }>> {
    return this.tx(undefined, c, () => {
      const t = this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id);
      if (!t) throw new Fail(404, 'count_task_not_found', 'That count does not exist.');
      if (t.state !== 'open') throw new Fail(409, 'count_closed', 'This count is already closed.');
      for (const l of lines) {
        if (!this.one(`SELECT 1 FROM count_task_lines WHERE task_id = ? AND product_id = ?`, id, l.productId)) throw new Fail(404, 'not_in_count', 'One of those products is not part of this count.');
        this.run(`UPDATE count_task_lines SET counted = ? WHERE task_id = ? AND product_id = ?`, l.counted, id, l.productId);
      }
      return { status: 200, body: { task: this.taskView(t, false) } };
    });
  }

  /** Writes a `count` movement for every difference. Lines nobody counted are left alone. Big variances wait for approval unless the submitter can decide. */
  submitCountTask(c: Caller, id: string, canDecide: boolean): Result<Out<{ task: CountTask; applied: number; waitingForApproval: number }>> {
    return this.tx(undefined, c, () => {
      const t = this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id);
      if (!t) throw new Fail(404, 'count_task_not_found', 'That count does not exist.');
      if (t.state !== 'open') throw new Fail(409, 'count_closed', 'This count is already closed.');
      let applied = 0;
      let waiting = 0;
      for (const l of this.all<Row>(`SELECT * FROM count_task_lines WHERE task_id = ? AND counted IS NOT NULL`, id)) {
        const pid = l.product_id as string;
        const have = this.one<{ on_hand: number }>(`SELECT on_hand FROM stock_levels WHERE product_id = ? AND location_id = ?`, pid, t.location_id as string)?.on_hand ?? 0;
        this.run(`UPDATE count_task_lines SET expected = ? WHERE task_id = ? AND product_id = ?`, have, id, pid);
        if (have === l.counted) continue;
        const input = { productId: pid, locationId: t.location_id as string, counted: l.counted as number, note: `Count task ${id}` };
        if (!canDecide && this.checkApproval(c, 'count', input)) { waiting++; continue; }
        this.move(c, pid, t.location_id as string, (l.counted as number) - have, 'count', null, `Count task ${id}`);
        applied++;
      }
      this.run(`UPDATE count_tasks SET state = 'submitted', submitted_at = ? WHERE id = ?`, nowIso(), id);
      this.audit(c, 'count_task.submit', 'count_task', id, { applied, waitingForApproval: waiting });
      return { status: 200, body: { task: this.taskView(this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id)!, true), applied, waitingForApproval: waiting } };
    });
  }

  cancelCountTask(c: Caller, id: string): Result<Out<{ task: CountTask }>> {
    return this.tx(undefined, c, () => {
      const t = this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id);
      if (!t) throw new Fail(404, 'count_task_not_found', 'That count does not exist.');
      if (t.state !== 'open') throw new Fail(409, 'count_closed', 'This count is already closed.');
      this.run(`UPDATE count_tasks SET state = 'cancelled' WHERE id = ?`, id);
      this.audit(c, 'count_task.cancel', 'count_task', id, undefined);
      return { status: 200, body: { task: this.taskView(this.one<Row>(`SELECT * FROM count_tasks WHERE id = ?`, id)!, true) } };
    });
  }

  // ---------------------------------------------------------- reports
  /** The business's calendar day for now, in its own timezone, so "today" means what the owner means. */
  private today(): string {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: this.settings().timezone || 'UTC' }).format(new Date()); } catch { return nowIso().slice(0, 10); }
  }

  private bumpStats(productId: string, locationId: string, reason: string, amount: number): void {
    const col = { sale: 'sold_qty', revenue: 'sold_minor', receive: 'received_qty', return: 'returned_qty', adjust: 'adjusted_qty', damage: 'damaged_qty', count: 'count_delta' }[reason];
    if (!col) return; // transfers and imports do not change what the business sold, received or lost
    const value = reason === 'sale' || reason === 'damage' ? -amount : amount;
    this.run(
      `INSERT INTO daily_stats(day, product_id, location_id, ${col}) VALUES (?, ?, ?, ?) ON CONFLICT(day, product_id, location_id) DO UPDATE SET ${col} = ${col} + excluded.${col}`,
      this.today(), productId, locationId, value,
    );
  }

  report(name: ReportName, q: { from?: string; to?: string; location?: string; days: number }): ReportResult {
    const to = q.to ?? this.today();
    const from = q.from ?? new Date(Date.parse(to) - 29 * 86400_000).toISOString().slice(0, 10);
    const loc = q.location ? ' AND d.location_id = ?' : '';
    const range: SqlStorageValue[] = q.location ? [from, to, q.location] : [from, to];
    const base = { name, from, to, totals: null as Record<string, number> | null };
    const sum = (rows: Record<string, string | number | null>[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)]));
    const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
    const int = (key: string, label: string) => ({ key, label, kind: 'int' as const });
    const text = (key: string, label: string) => ({ key, label, kind: 'text' as const });

    if (name === 'sales') {
      const rows = this.all<Row>(`SELECT d.day, SUM(d.sold_qty) AS units, SUM(d.sold_minor) AS revenue FROM daily_stats d WHERE d.day BETWEEN ? AND ?${loc} GROUP BY d.day HAVING units <> 0 OR revenue <> 0 ORDER BY d.day`, ...range) as Record<string, string | number | null>[];
      return { ...base, title: 'Sales by day', columns: [{ key: 'day', label: 'Day', kind: 'date' }, int('units', 'Units sold'), money('revenue', 'Revenue from shipped orders')], rows, totals: sum(rows, ['units', 'revenue']), note: 'Units count every sale in the stock ledger. Revenue counts shipped orders only.' };
    }
    if (name === 'sales-by-product') {
      const rows = this.all<Row>(
        `SELECT p.sku, p.name, SUM(d.sold_qty) AS units, SUM(d.sold_minor) AS revenue, SUM(d.sold_qty) * COALESCE(p.cost_minor, 0) AS cost,
                CASE WHEN p.cost_minor IS NULL THEN NULL ELSE SUM(d.sold_minor) - SUM(d.sold_qty) * p.cost_minor END AS margin
           FROM daily_stats d JOIN products p ON p.id = d.product_id WHERE d.day BETWEEN ? AND ?${loc} GROUP BY p.id HAVING units <> 0 OR revenue <> 0 ORDER BY revenue DESC, units DESC LIMIT 1000`, ...range) as Record<string, string | number | null>[];
      return { ...base, title: 'Sales by product', columns: [text('sku', 'SKU'), text('name', 'Product'), int('units', 'Units'), money('revenue', 'Revenue'), money('cost', 'Cost of goods'), money('margin', 'Margin')], rows, totals: sum(rows, ['units', 'revenue']) };
    }
    if (name === 'valuation') {
      const rows = this.all<Row>(
        `SELECT p.sku, p.name, SUM(s.on_hand) AS on_hand, p.cost_minor AS unit_cost, SUM(s.on_hand) * COALESCE(p.cost_minor, 0) AS value
           FROM stock_levels s JOIN products p ON p.id = s.product_id WHERE p.deleted_at IS NULL AND s.on_hand > 0${q.location ? ' AND s.location_id = ?' : ''} GROUP BY p.id ORDER BY value DESC LIMIT 2000`, ...(q.location ? [q.location] : [])) as Record<string, string | number | null>[];
      return { ...base, title: 'Stock valuation', columns: [text('sku', 'SKU'), text('name', 'Product'), int('on_hand', 'On hand'), money('unit_cost', 'Unit cost'), money('value', 'Value')], rows, totals: sum(rows, ['on_hand', 'value']), note: 'As of now, at cost. Products with no cost count as zero.' };
    }
    if (name === 'movements') {
      const r = this.one<Row>(`SELECT COALESCE(SUM(received_qty),0) AS received, COALESCE(SUM(returned_qty),0) AS returned, COALESCE(SUM(sold_qty),0) AS sold, COALESCE(SUM(adjusted_qty),0) AS adjusted, COALESCE(SUM(damaged_qty),0) AS damaged, COALESCE(SUM(count_delta),0) AS counted FROM daily_stats d WHERE d.day BETWEEN ? AND ?${loc}`, ...range)!;
      const rows = [['Received', Number(r.received)], ['Returned by customers', Number(r.returned)], ['Sold', -Number(r.sold)], ['Adjusted', Number(r.adjusted)], ['Damaged', -Number(r.damaged)], ['Corrected by counts', Number(r.counted)]].map(([reason, units]) => ({ reason: reason as string, units: units as number }));
      return { ...base, title: 'Stock movements by reason', columns: [text('reason', 'Reason'), int('units', 'Units (+ in, − out)')], rows, totals: sum(rows, ['units']) };
    }
    if (name === 'low-stock') {
      const rows = this.all<Row>(
        `SELECT p.sku, p.name, p.on_hand_total AS on_hand, p.reorder_point,
                COALESCE((SELECT SUM(d.sold_qty) FROM daily_stats d WHERE d.product_id = p.id AND d.day >= ?), 0) AS sold_recent
           FROM products p WHERE p.deleted_at IS NULL AND p.reorder_point IS NOT NULL AND p.on_hand_total <= p.reorder_point ORDER BY p.on_hand_total ASC, p.name LIMIT 1000`, new Date(Date.parse(this.today()) - 29 * 86400_000).toISOString().slice(0, 10))
        .map((r) => ({ sku: r.sku, name: r.name, on_hand: r.on_hand, reorder_point: r.reorder_point, days_of_cover: Number(r.sold_recent) > 0 ? Math.floor(Number(r.on_hand) / (Number(r.sold_recent) / 30)) : null })) as Record<string, string | number | null>[];
      return { ...base, title: 'Low and out of stock', columns: [text('sku', 'SKU'), text('name', 'Product'), int('on_hand', 'On hand'), int('reorder_point', 'Reorder point'), int('days_of_cover', 'Days of cover')], rows, totals: null, note: 'Days of cover uses the last 30 days of sales. Blank means nothing sold.' };
    }
    if (name === 'dead-stock') {
      const since = new Date(Date.parse(this.today()) - q.days * 86400_000).toISOString().slice(0, 10);
      const rows = this.all<Row>(
        `SELECT p.sku, p.name, p.on_hand_total AS on_hand, p.on_hand_total * COALESCE(p.cost_minor, 0) AS value,
                (SELECT MAX(d.day) FROM daily_stats d WHERE d.product_id = p.id AND d.sold_qty > 0) AS last_sold
           FROM products p WHERE p.deleted_at IS NULL AND p.on_hand_total > 0
            AND NOT EXISTS (SELECT 1 FROM daily_stats d WHERE d.product_id = p.id AND d.sold_qty > 0 AND d.day >= ?) ORDER BY value DESC, p.name LIMIT 1000`, since) as Record<string, string | number | null>[];
      return { ...base, from: since, title: `Dead stock: nothing sold in ${q.days} days`, columns: [text('sku', 'SKU'), text('name', 'Product'), int('on_hand', 'On hand'), money('value', 'Value tied up'), { key: 'last_sold', label: 'Last sold', kind: 'date' }], rows, totals: sum(rows, ['on_hand', 'value']) };
    }
    const rows = this.all<Row>(
      `SELECT p.sku, p.name, SUM(d.damaged_qty) AS damaged, SUM(CASE WHEN d.adjusted_qty < 0 THEN -d.adjusted_qty ELSE 0 END) AS adjusted_down, SUM(CASE WHEN d.count_delta < 0 THEN -d.count_delta ELSE 0 END) AS count_loss,
              (SUM(d.damaged_qty) + SUM(CASE WHEN d.adjusted_qty < 0 THEN -d.adjusted_qty ELSE 0 END) + SUM(CASE WHEN d.count_delta < 0 THEN -d.count_delta ELSE 0 END)) AS units,
              (SUM(d.damaged_qty) + SUM(CASE WHEN d.adjusted_qty < 0 THEN -d.adjusted_qty ELSE 0 END) + SUM(CASE WHEN d.count_delta < 0 THEN -d.count_delta ELSE 0 END)) * COALESCE(p.cost_minor, 0) AS value
         FROM daily_stats d JOIN products p ON p.id = d.product_id WHERE d.day BETWEEN ? AND ?${loc} GROUP BY p.id HAVING units > 0 ORDER BY value DESC, units DESC LIMIT 1000`, ...range) as Record<string, string | number | null>[];
    return { ...base, title: 'Shrinkage and write-offs', columns: [text('sku', 'SKU'), text('name', 'Product'), int('damaged', 'Damaged'), int('adjusted_down', 'Adjusted down'), int('count_loss', 'Lost in counts'), int('units', 'Total units'), money('value', 'Value at cost')], rows, totals: sum(rows, ['units', 'value']) };
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
    for (const r of this.all(
      `SELECT m.product_id, m.total AS ledger, COALESCE(d.total, 0) AS rollup
         FROM (SELECT product_id, SUM(-delta) AS total FROM stock_movements WHERE reason = 'sale' GROUP BY product_id) m
         LEFT JOIN (SELECT product_id, SUM(sold_qty) AS total FROM daily_stats GROUP BY product_id) d ON d.product_id = m.product_id
        WHERE m.total <> COALESCE(d.total, 0)`,
    )) drift.push(JSON.stringify({ invariant: 'I8', ...r }));
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
