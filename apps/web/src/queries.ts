import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Dashboard, Location, Movement, Page, Product, Role, StockLevel } from '@shoplist/shared';
import { api, ApiError } from './api';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  currency: string;
  role: Role;
}
export interface Me {
  user: { id: string; email: string; name: string; avatarUrl: string | null };
  organizations: OrgSummary[];
}

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('GET', '/me'),
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
    staleTime: 60_000,
  });

export interface ProductFilters {
  q?: string;
  stock?: 'in' | 'low' | 'out';
  location?: string;
  tag?: string;
  sort: '-updatedAt' | 'name';
}

export function productQuery(f: ProductFilters, cursor?: string, limit = 50): string {
  const p = new URLSearchParams({ limit: String(limit), sort: f.sort });
  if (f.q) p.set('q', f.q);
  if (f.stock) p.set('stock', f.stock);
  if (f.location) p.set('location', f.location);
  if (f.tag) p.set('tag', f.tag);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export const useDashboard = (orgId: string) =>
  useQuery({ queryKey: ['org', orgId, 'dashboard'], queryFn: () => api<Dashboard>('GET', `/orgs/${orgId}/dashboard`) });

export const useLocations = (orgId: string) =>
  useQuery({ queryKey: ['org', orgId, 'locations'], queryFn: () => api<{ data: Location[] }>('GET', `/orgs/${orgId}/locations`).then((r) => r.data) });

export const useProducts = (orgId: string, filters: ProductFilters) =>
  useInfiniteQuery({
    queryKey: ['org', orgId, 'products', filters],
    queryFn: ({ pageParam }) => api<Page<Product>>('GET', `/orgs/${orgId}/products?${productQuery(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });

export const useProduct = (orgId: string, id: string | null) =>
  useQuery({
    queryKey: ['org', orgId, 'product', id],
    enabled: !!id,
    queryFn: () => api<{ product: Product; levels: StockLevel[] }>('GET', `/orgs/${orgId}/products/${id}`),
  });

export const useMovements = (orgId: string, f: { productId?: string; locationId?: string; reason?: string }) =>
  useInfiniteQuery({
    queryKey: ['org', orgId, 'movements', f],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      if (pageParam) p.set('cursor', pageParam);
      return api<Page<Movement>>('GET', `/orgs/${orgId}/stock/movements?${p}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const canWrite = (role: Role) => role !== 'viewer';
export const canAdmin = (role: Role) => role === 'admin' || role === 'owner';
