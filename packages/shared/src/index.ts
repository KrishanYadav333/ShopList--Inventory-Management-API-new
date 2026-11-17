import { z } from 'zod';

// ---------------------------------------------------------------- roles
export const ROLES = ['admin', 'manager', 'sales', 'stock', 'accountant', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Levels are by job, not a ladder (the same idea as a clinic ERP: platform developer, one admin who owns the
 * business, then staff whose access depends on their job).
 *   Developer (super admin): the platform only, set in configuration, never stored here.
 *   admin: the business owner. One per organization. Everything in their own organization.
 *   manager, sales, stock, viewer: staff roles the admin assigns. The admin chooses a role; nobody can redefine one.
 */
export const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', manager: 'Manager', sales: 'Sales', stock: 'Stock keeper', accountant: 'Accountant', viewer: 'Viewer' };

export const ROLE_SUMMARY: Record<Role, string> = {
  admin: 'The business owner. Everything, plus team, invitations, locations, API keys, webhooks, the activity log and deleting the organization.',
  manager: 'Runs daily operations: products, prices, stock, orders and imports. No team or settings.',
  sales: 'Works orders: create, take payment, ship, cancel. Can see products and stock. Cannot change products or stock.',
  stock: 'Moves stock: receive, adjust, transfer, count. Can see products and orders. Cannot change products or orders.',
  accountant: 'Reads the numbers: costs, stock value and the activity log. Cannot change stock, products or orders.',
  viewer: 'Read-only: products, stock, orders and history. No costs.',
};

export const PERMISSIONS = ['inventory:read', 'cost:read', 'reports:read', 'purchasing:write', 'counts:assign', 'customers:read', 'approvals:decide', 'products:write', 'stock:write', 'orders:write', 'team:manage', 'settings:manage', 'audit:read', 'org:delete'] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Never available to an API key, whatever its scopes: these need a signed-in person. */
export const SESSION_ONLY: readonly Permission[] = ['team:manage', 'settings:manage', 'audit:read', 'org:delete'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ['inventory:read'],
  sales: ['inventory:read', 'customers:read', 'orders:write'],
  stock: ['inventory:read', 'stock:write'],
  accountant: ['inventory:read', 'customers:read', 'cost:read', 'reports:read', 'audit:read'],
  manager: ['inventory:read', 'customers:read', 'cost:read', 'reports:read', 'purchasing:write', 'counts:assign', 'approvals:decide', 'products:write', 'stock:write', 'orders:write'],
  admin: PERMISSIONS,
};
export const can = (role: Role, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);

// ---------------------------------------------------------------- limits
export const LIMITS = {
  maxOnHand: 10_000_000,
  maxPriceMinor: 100_000_000,
  maxPageSize: 200,
  defaultPageSize: 50,
} as const;

// ---------------------------------------------------------------- stock
/** Reasons a client may submit. `count`, `transfer_*` and `import` are written by the server only. */
export const CLIENT_REASONS = ['receive', 'sale', 'return', 'adjust', 'damage'] as const;
export const MOVEMENT_REASONS = [...CLIENT_REASONS, 'count', 'transfer_in', 'transfer_out', 'import'] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

const money = z.number().int().min(0).max(LIMITS.maxPriceMinor);
const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------- products
// Fields shared by create and update. No defaults here: a default would also apply to omitted
// fields in a partial update and silently overwrite stored values (e.g. wipe a product's tags).
const productFields = {
  sku: text(64),
  name: text(200),
  description: z.string().max(5000).nullish(),
  barcode: text(64).nullish(),
  unit: text(20),
  priceMinor: money,
  costMinor: money.nullish(),
  reorderPoint: z.number().int().min(0).max(LIMITS.maxOnHand).nullish(),
  tags: z.array(text(40)).max(20),
};

export const productInput = z
  .object({
    ...productFields,
    unit: productFields.unit.default('each'),
    tags: productFields.tags.default([]),
    /** Units received into the default location when the product is created. */
    initialQuantity: z.number().int().min(0).max(LIMITS.maxOnHand).default(0),
  })
  .strict();
export type ProductInput = z.infer<typeof productInput>;

export const productPatch = z
  .object(productFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to change' });
export type ProductPatch = z.infer<typeof productPatch>;

export type StockStatus = 'in' | 'low' | 'out';

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  unit: string;
  priceMinor: number;
  costMinor: number | null;
  reorderPoint: number | null;
  tags: string[];
  onHand: number;
  reserved: number;
  available: number;
  status: StockStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StockLevel {
  productId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  available: number;
}

export interface Movement {
  id: string;
  productId: string;
  productName?: string;
  productSku?: string;
  locationId: string;
  delta: number;
  reason: MovementReason;
  reference: string | null;
  note: string | null;
  balance: number;
  actor: string;
  createdAt: string;
}

export interface Location {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
  archivedAt: string | null;
}

// ---------------------------------------------------------------- inputs
export const movementInput = z
  .object({
    productId: text(40),
    locationId: text(40),
    delta: z.number().int().refine((n) => n !== 0, 'delta must not be 0').refine((n) => Math.abs(n) <= LIMITS.maxOnHand),
    reason: z.enum(CLIENT_REASONS),
    reference: text(100).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type MovementInput = z.infer<typeof movementInput>;

export const transferInput = z
  .object({
    productId: text(40),
    fromLocationId: text(40),
    toLocationId: text(40),
    quantity: z.number().int().min(1).max(LIMITS.maxOnHand),
    reference: text(100).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((v) => v.fromLocationId !== v.toLocationId, { message: 'Choose two different locations', path: ['toLocationId'] });
export type TransferInput = z.infer<typeof transferInput>;

export const countInput = z
  .object({
    productId: text(40),
    locationId: text(40),
    counted: z.number().int().min(0).max(LIMITS.maxOnHand),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type CountInput = z.infer<typeof countInput>;

export const locationInput = z
  .object({ name: text(100), code: text(20).transform((s) => s.toUpperCase()) })
  .strict();
export type LocationInput = z.infer<typeof locationInput>;

// ---------------------------------------------------------------- import
export const IMPORT_MAX_ROWS = 100;
export const importRow = z
  .object({
    sku: text(64),
    name: text(200),
    priceMinor: money,
    costMinor: money.nullish(),
    barcode: text(64).nullish(),
    unit: text(20).optional(),
    reorderPoint: z.number().int().min(0).max(LIMITS.maxOnHand).nullish(),
    tags: z.array(text(40)).max(20).optional(),
    description: z.string().max(5000).nullish(),
    /** Desired on-hand quantity at the default location. */
    quantity: z.number().int().min(0).max(LIMITS.maxOnHand).optional(),
  })
  .strict();
export type ImportRow = z.infer<typeof importRow>;
export const importRequest = z
  .object({ mode: z.enum(['create', 'upsert']), rows: z.array(z.unknown()).min(1).max(IMPORT_MAX_ROWS) })
  .strict();
export interface ImportResult {
  index: number;
  sku: string;
  status: 'created' | 'updated' | 'unchanged' | 'error';
  id?: string;
  error?: string;
}

// --------------------------------------------------------------- webhooks
export const WEBHOOK_EVENTS = ['product.created', 'product.updated', 'product.deleted', 'stock.changed', 'stock.low', 'stock.out', 'order.created', 'order.shipped', 'order.cancelled'] as const;
export const webhookInput = z
  .object({
    url: z.string().trim().url().max(500),
    events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1, 'Choose at least one event').max(WEBHOOK_EVENTS.length + 1),
  })
  .strict();

export const API_KEY_SCOPES = ['inventory:read', 'inventory:write', 'products:write', 'stock:write', 'orders:write', 'reports:read', 'cost:read'] as const;
export const API_KEY_SCOPE_LABELS: Record<(typeof API_KEY_SCOPES)[number], string> = {
  'inventory:read': 'Read products, stock and orders',
  'inventory:write': 'Write everything (products, stock and orders, with costs). The old all-in-one scope',
  'products:write': 'Create and edit products',
  'stock:write': 'Move stock',
  'orders:write': 'Create and ship orders',
  'reports:read': 'Read reports',
  'cost:read': 'See cost prices',
};
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
/** What a key may do. Every key can read inventory; the old `inventory:write` means products, stock, orders and costs. Never team, settings or the log. */
export function keyPermissions(scopes: readonly string[]): Permission[] {
  const out = new Set<Permission>(['inventory:read']);
  for (const sc of scopes) {
    if (sc === 'inventory:write') ['products:write', 'stock:write', 'orders:write', 'cost:read', 'customers:read'].forEach((p) => out.add(p as Permission));
    else if (['products:write', 'stock:write', 'orders:write', 'reports:read', 'cost:read'].includes(sc)) out.add(sc as Permission);
    if (sc === 'orders:write') out.add('customers:read'); // an order integration reads back the customer details it sent
  }
  return [...out];
}
export const apiKeyInput = z
  .object({
    name: text(60),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Choose at least one permission').max(API_KEY_SCOPES.length),
    expiresInDays: z.number().int().min(1).max(365).nullish(),
  })
  .strict();

export const orgInput = z.object({ name: text(100) }).strict();

export const inviteInput = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ROLES), confirmSecondAdmin: z.boolean().optional(), locationIds: z.array(z.string().max(40)).max(50).nullable().optional() })
  .strict();

export const memberPatch = z
  .object({ role: z.enum(ROLES).optional(), confirmSecondAdmin: z.boolean().optional(), locationIds: z.array(z.string().max(40)).max(50).nullable().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.locationIds !== undefined, 'Change a role or the locations');

// ---------------------------------------------------------------- queries
const limit = z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(LIMITS.defaultPageSize);

export const productListQuery = z.object({
  limit,
  cursor: z.string().max(500).optional(),
  q: z.string().trim().max(100).optional(),
  location: z.string().max(40).optional(),
  stock: z.enum(['in', 'low', 'out']).optional(),
  tag: z.string().max(40).optional(),
  sort: z.enum(['-updatedAt', 'name']).default('-updatedAt'),
});
export type ProductListQuery = z.infer<typeof productListQuery>;

export const movementListQuery = z.object({
  limit,
  cursor: z.string().max(500).optional(),
  productId: z.string().max(40).optional(),
  locationId: z.string().max(40).optional(),
  reason: z.enum(MOVEMENT_REASONS).optional(),
});
export type MovementListQuery = z.infer<typeof movementListQuery>;

export const pageQuery = z.object({ limit, cursor: z.string().max(500).optional() });

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------- orders
export const ORDER_STATES = ['payment_required', 'waiting_for_stock', 'ready_to_ship', 'shipped', 'cancelled'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const ORDER_CHANNELS = ['manual', 'shopify', 'amazon', 'ebay', 'woocommerce', 'magento', 'phone', 'other'] as const;

export const orderInput = z
  .object({
    customerName: text(120),
    customerEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code').nullish(),
    customerId: text(40).nullish(),
    channel: z.enum(ORDER_CHANNELS).default('manual'),
    note: z.string().trim().max(500).nullish(),
    locationId: text(40).nullish(),
    paid: z.boolean().default(false),
    lines: z
      .array(z.object({ productId: text(40), quantity: z.number().int().min(1).max(100_000) }).strict())
      .min(1, 'Add at least one item')
      .max(50)
      .refine((l) => new Set(l.map((x) => x.productId)).size === l.length, 'Each product can appear once'),
  })
  .strict();
export type OrderInput = z.infer<typeof orderInput>;

export const orderListQuery = z.object({
  limit,
  cursor: z.string().max(500).optional(),
  state: z.enum(ORDER_STATES).optional(),
  q: z.string().trim().max(100).optional(),
});
export type OrderListQuery = z.infer<typeof orderListQuery>;

export const paidInput = z.object({ paid: z.boolean() }).strict();

export interface OrderLine {
  id: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  reserved: number;
  unitPriceMinor: number;
}

export interface Order {
  id: string;
  number: string;
  channel: string;
  customerName: string;
  customerEmail: string | null;
  country: string | null;
  note: string | null;
  locationId: string;
  paid: boolean;
  state: OrderState;
  customerId: string | null;
  /** What the customer pays: lines plus tax when tax is added on top. */
  totalMinor: number;
  subtotalMinor: number;
  taxMinor: number;
  taxMode: 'none' | 'inclusive' | 'exclusive';
  lines: OrderLine[];
  version: number;
  createdAt: string;
  updatedAt: string;
  shippedAt: string | null;
}

export interface OrderCounts {
  payment_required: number;
  waiting_for_stock: number;
  ready_to_ship: number;
  shipped: number;
  cancelled: number;
}

export interface Dashboard {
  orders: OrderCounts;
  products: number;
  lowStock: number;
  outOfStock: number;
  inventoryValueMinor: number;
  needsAttention: Product[];
  recentMovements: Movement[];
}

// ---------------------------------------------------------------- business settings
const isTimezone = (v: string) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } };
const optText = (max: number) => z.string().trim().max(max).nullish();
/** Everything a business can configure about itself. All optional on update; defaults live in `SETTINGS_DEFAULTS`. */
export const approvalRules = z
  .object({
    largeAdjustment: z.object({ on: z.boolean(), units: z.number().int().min(1).max(LIMITS.maxOnHand), valueMinor: z.number().int().min(0).max(LIMITS.maxPriceMinor * 100) }).strict(),
    damage: z.object({ on: z.boolean() }).strict(),
    countVariance: z.object({ on: z.boolean(), units: z.number().int().min(1).max(LIMITS.maxOnHand) }).strict(),
    cancelPaid: z.object({ on: z.boolean() }).strict(),
    priceDrop: z.object({ on: z.boolean(), percent: z.number().int().min(1).max(100) }).strict(),
  })
  .strict();
export type ApprovalRules = z.infer<typeof approvalRules>;
export const APPROVAL_DEFAULTS: ApprovalRules = {
  largeAdjustment: { on: false, units: 20, valueMinor: 50_000 },
  damage: { on: false },
  countVariance: { on: false, units: 20 },
  cancelPaid: { on: false },
  priceDrop: { on: false, percent: 30 },
};
export const APPROVAL_STATES = ['pending', 'approved', 'applied', 'rejected', 'withdrawn', 'expired', 'failed'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export interface ApprovalView {
  id: string;
  kind: 'movement' | 'count' | 'cancel_order' | 'price_drop';
  summary: string;
  requestedBy: string;
  state: ApprovalState;
  decidedBy: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export const orgSettings = z
  .object({
    legalName: optText(120),
    address: optText(300),
    phone: optText(40),
    email: z.string().trim().toLowerCase().email().max(254).nullish().or(z.literal('')),
    taxId: optText(40),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
    taxMode: z.enum(['none', 'inclusive', 'exclusive']),
    taxRateBp: z.number().int().min(0).max(10_000),
    timezone: z.string().trim().max(60).refine(isTimezone, 'Unknown timezone'),
    orderPrefix: z.string().trim().max(8).regex(/^[A-Za-z0-9#_-]*$/, 'Letters, numbers, # _ - only'),
    poPrefix: z.string().trim().max(8).regex(/^[A-Za-z0-9#_-]*$/, 'Letters, numbers, # _ - only'),
    invoicePrefix: z.string().trim().max(8).regex(/^[A-Za-z0-9#_-]*$/, 'Letters, numbers, # _ - only'),
    defaultReorderPoint: z.number().int().min(0).max(LIMITS.maxOnHand).nullable(),
    /** How long the activity log is kept (F30). */
    auditRetentionYears: z.number().int().min(1).max(7),
    approvals: approvalRules,
  })
  .strict();
export type OrgSettings = z.infer<typeof orgSettings>;
export const orgSettingsPatch = orgSettings.partial();
export const SETTINGS_DEFAULTS: OrgSettings = {
  legalName: null, address: null, phone: null, email: null, taxId: null,
  currency: 'USD', taxMode: 'none', taxRateBp: 0, timezone: 'UTC',
  orderPrefix: 'ORD-', poPrefix: 'PO-', invoicePrefix: 'INV-', defaultReorderPoint: null, auditRetentionYears: 2, approvals: APPROVAL_DEFAULTS,
};

// ---------------------------------------------------------------- reports
export const REPORTS = ['sales', 'sales-by-product', 'valuation', 'movements', 'low-stock', 'dead-stock', 'shrinkage'] as const;
export type ReportName = (typeof REPORTS)[number];
export const REPORT_TITLES: Record<ReportName, string> = {
  sales: 'Sales by day',
  'sales-by-product': 'Sales by product',
  valuation: 'Stock valuation',
  movements: 'Stock movements by reason',
  'low-stock': 'Low and out of stock',
  'dead-stock': 'Dead stock (not selling)',
  shrinkage: 'Shrinkage and write-offs',
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const reportQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  location: z.string().max(40).optional(),
  days: z.coerce.number().int().min(1).max(365).default(60),
  format: z.enum(['json', 'csv']).default('json'),
});
export interface ReportResult {
  name: ReportName;
  title: string;
  from: string;
  to: string;
  columns: { key: string; label: string; kind: 'text' | 'int' | 'money' | 'date' }[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number> | null;
  note?: string;
}

// ---------------------------------------------------------------- purchasing
export const supplierInput = z
  .object({
    name: text(120),
    email: z.string().trim().toLowerCase().email().max(254).nullish().or(z.literal('')),
    phone: z.string().trim().max(40).nullish(),
    leadTimeDays: z.number().int().min(0).max(365).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type SupplierInput = z.infer<typeof supplierInput>;
export interface Supplier { id: string; name: string; email: string | null; phone: string | null; leadTimeDays: number | null; note: string | null; archivedAt: string | null; createdAt: string }

export const PO_STATES = ['draft', 'sent', 'partially_received', 'received', 'cancelled', 'closed'] as const;
export type PoState = (typeof PO_STATES)[number];
const poLine = z.object({ productId: text(40), quantity: z.number().int().min(1).max(LIMITS.maxOnHand), unitCostMinor: money }).strict();
export const purchaseOrderInput = z
  .object({
    supplierId: text(40),
    locationId: text(40),
    expectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    note: z.string().trim().max(500).nullish(),
    lines: z.array(poLine).min(1, 'Add at least one item').max(100).refine((l) => new Set(l.map((x) => x.productId)).size === l.length, 'Each product can appear once'),
  })
  .strict();
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInput>;
export const purchaseOrderPatch = purchaseOrderInput.partial().strict();
export const receiveInput = z.object({ lines: z.array(z.object({ lineId: text(40), quantity: z.number().int().min(1).max(LIMITS.maxOnHand) }).strict()).min(1).max(100) }).strict();
export type ReceiveInput = z.infer<typeof receiveInput>;
export interface PurchaseOrderLine { id: string; productId: string; sku: string; name: string; quantity: number; received: number; unitCostMinor: number }
export interface PurchaseOrder {
  id: string; number: string; supplierId: string; supplierName: string; locationId: string; state: PoState;
  expectedAt: string | null; note: string | null; createdBy: string; createdAt: string; updatedAt: string; version: number;
  lines: PurchaseOrderLine[]; totalCostMinor: number;
}

// ---------------------------------------------------------------- count tasks
export const COUNT_STATES = ['open', 'submitted', 'cancelled'] as const;
export type CountState = (typeof COUNT_STATES)[number];
export const countScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('tag'), tag: text(40) }).strict(),
  z.object({ kind: z.literal('list'), productIds: z.array(text(40)).min(1).max(500) }).strict(),
  z.object({ kind: z.literal('stale'), days: z.number().int().min(1).max(365) }).strict(),
]);
export const countTaskInput = z
  .object({
    title: z.string().trim().max(100).nullish(),
    locationId: text(40),
    scope: countScope,
    assignedTo: text(60).nullish(),
    dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    blind: z.boolean().default(true),
  })
  .strict();
export type CountTaskInput = z.infer<typeof countTaskInput>;
export const countLinesInput = z.object({ lines: z.array(z.object({ productId: text(40), counted: z.number().int().min(0).max(LIMITS.maxOnHand) }).strict()).min(1).max(500) }).strict();
export interface CountTaskLine { productId: string; sku: string; name: string; counted: number | null; expected: number | null }
export interface CountTask {
  id: string; title: string | null; locationId: string; blind: boolean; assignedTo: string | null; dueAt: string | null; state: CountState;
  createdBy: string; createdAt: string; submittedAt: string | null; lines: CountTaskLine[]; summary: { total: number; counted: number; variances: number } | null;
}

// ---------------------------------------------------------------- customers and tax
export const customerInput = z
  .object({
    name: text(120),
    email: z.string().trim().toLowerCase().email().max(254).nullish().or(z.literal('')),
    phone: z.string().trim().max(40).nullish(),
    address: z.string().trim().max(300).nullish(),
    taxId: z.string().trim().max(40).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();
export type CustomerInput = z.infer<typeof customerInput>;
export interface Customer {
  id: string; name: string; email: string | null; phone: string | null; address: string | null; taxId: string | null; note: string | null;
  archivedAt: string | null; createdAt: string; orders: number; spentMinor: number; lastOrderAt: string | null;
}
export type TaxMode = 'none' | 'inclusive' | 'exclusive';
/** Tax for one line, rounded half up per line. Inclusive prices already contain the tax; exclusive adds it on top. */
export function lineTax(mode: TaxMode, rateBp: number, lineMinor: number): number {
  if (mode === 'none' || rateBp <= 0) return 0;
  return mode === 'exclusive' ? Math.round((lineMinor * rateBp) / 10_000) : Math.round((lineMinor * rateBp) / (10_000 + rateBp));
}

// ------------------------------------------------------------------ plans (F20)
export const PLAN_LIMIT_KEYS = ['products', 'members', 'locations', 'apiKeys', 'webhooks', 'ordersPerMonth', 'importsPerDay'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export const PLAN_LIMIT_LABELS: Record<PlanLimitKey, string> = {
  products: 'Products', members: 'Team members (including pending invitations)', locations: 'Locations', apiKeys: 'Active API keys', webhooks: 'Webhooks', ordersPerMonth: 'Orders per month', importsPerDay: 'Imports per day',
};
export const PLAN_FEATURE_KEYS = ['orders', 'purchasing', 'approvals', 'reports', 'apiKeys', 'webhooks', 'import', 'supportAccess'] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export const PLAN_FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  orders: 'Orders', purchasing: 'Suppliers and purchase orders', approvals: 'Approvals', reports: 'Reports', apiKeys: 'API keys', webhooks: 'Webhooks', import: 'Product import', supportAccess: 'Support access',
};
/** A missing or null limit means unlimited. */
export type PlanLimits = Partial<Record<PlanLimitKey, number | null>>;
export type PlanFeatures = Record<PlanFeatureKey, boolean>;

export const planLimitsInput = z.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, z.number().int().min(0).max(100_000_000).nullable().optional()])) as Record<PlanLimitKey, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>).strict();
export const planFeaturesInput = z.object(Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, z.boolean().optional()])) as Record<PlanFeatureKey, z.ZodOptional<z.ZodBoolean>>).strict();
export const planOverrides = z.object({ limits: planLimitsInput.optional(), features: planFeaturesInput.optional() }).strict();
export type PlanOverrides = z.infer<typeof planOverrides>;

/** Plan values with the business's own overrides on top. Unknown or damaged JSON falls back to the plan. */
export function resolvePlan(limitsJson: string, featuresJson: string, overridesJson: string | null): { limits: PlanLimits; features: PlanFeatures } {
  const parse = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
  const limits: PlanLimits = { ...parse<PlanLimits>(limitsJson, {}) };
  const features = Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, true])) as PlanFeatures;
  Object.assign(features, parse<Partial<PlanFeatures>>(featuresJson, {}));
  const o = parse<PlanOverrides>(overridesJson, {});
  for (const [k, v] of Object.entries(o.limits ?? {})) if (v !== undefined) limits[k as PlanLimitKey] = v;
  for (const [k, v] of Object.entries(o.features ?? {})) if (typeof v === 'boolean') features[k as PlanFeatureKey] = v;
  return { limits, features };
}
