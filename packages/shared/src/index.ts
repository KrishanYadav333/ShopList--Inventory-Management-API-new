import { z } from 'zod';

// ---------------------------------------------------------------- roles
export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Minimum role needed for each permission. Every route declares exactly one. */
export const PERMISSIONS = {
  'inventory:read': 'viewer',
  'inventory:write': 'editor',
  'org:manage': 'admin',
  'org:owner': 'owner',
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

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
export const productInput = z
  .object({
    sku: text(64),
    name: text(200),
    description: z.string().max(5000).nullish(),
    barcode: text(64).nullish(),
    unit: text(20).default('each'),
    priceMinor: money,
    costMinor: money.nullish(),
    reorderPoint: z.number().int().min(0).max(LIMITS.maxOnHand).nullish(),
    tags: z.array(text(40)).max(20).default([]),
    /** Units received into the default location when the product is created. */
    initialQuantity: z.number().int().min(0).max(LIMITS.maxOnHand).default(0),
  })
  .strict();
export type ProductInput = z.infer<typeof productInput>;

export const productPatch = productInput
  .omit({ initialQuantity: true })
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

export const orgInput = z.object({ name: text(100) }).strict();

export const inviteInput = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'editor', 'viewer']) })
  .strict();

export const memberPatch = z.object({ role: z.enum(ROLES) }).strict();

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

export interface Dashboard {
  products: number;
  lowStock: number;
  outOfStock: number;
  inventoryValueMinor: number;
  needsAttention: Product[];
  recentMovements: Movement[];
}
