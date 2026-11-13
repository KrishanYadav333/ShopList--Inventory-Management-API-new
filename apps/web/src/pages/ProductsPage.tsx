import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Product } from '@shoplist/shared';
import { api, ApiError, newKey } from '../api';
import { useShell } from '../components/Shell';
import { avatarClass, csvCell, dateParts, money } from '../format';
import { Icon } from '../icons';
import { canWrite, useProducts, type ProductFilters } from '../queries';
import { useToast } from '../toast';

const STATUS = { in: ['ready', 'In stock'], low: ['low', 'Low stock'], out: ['out', 'Out of stock'] } as const;

const SAMPLES = [
  { sku: 'MOUSE-001', name: 'Wireless Mouse', priceMinor: 2999, costMinor: 1400, reorderPoint: 10, initialQuantity: 42, tags: ['office', 'accessories'] },
  { sku: 'KEYB-002', name: 'Mechanical Keyboard', priceMinor: 8999, costMinor: 5200, reorderPoint: 8, initialQuantity: 6, tags: ['office', 'accessories'] },
  { sku: 'MON-27', name: '27" 4K Monitor', priceMinor: 32900, costMinor: 21000, reorderPoint: 4, initialQuantity: 0, tags: ['displays'] },
  { sku: 'CABLE-USBC', name: 'USB-C Cable 2 m', priceMinor: 1299, costMinor: 350, reorderPoint: 25, initialQuantity: 180, tags: ['cables'] },
];

export function ProductsPage() {
  const { org, openNew, openAdjust, openEdit } = useShell();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const write = canWrite(org.role);

  // Debounce typing into the URL so filtered views are shareable.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text.trim()) next.set('q', text.trim()); else next.delete('q');
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters: ProductFilters = {
    q: params.get('q') ?? undefined,
    stock: (params.get('stock') as ProductFilters['stock']) ?? undefined,
    location: params.get('location') ?? undefined,
    tag: params.get('tag') ?? undefined,
    sort: params.get('sort') === 'name' ? 'name' : '-updatedAt',
  };
  const query = useProducts(org.id, filters);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const filtered = !!(filters.q || filters.stock || filters.location || filters.tag);

  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });

  const remove = useMutation({
    mutationFn: (p: Product) => api('DELETE', `/orgs/${org.id}/products/${p.id}`, { ifMatch: p.version }),
    onSuccess: (_r, p) => {
      refresh();
      toast({
        text: `Deleted ${p.name}`,
        action: {
          label: 'Undo',
          run: () => api('POST', `/orgs/${org.id}/products/${p.id}/restore`, { body: {} }).then(refresh).catch((e: ApiError) => toast({ kind: 'error', text: e.message })),
        },
      });
    },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });

  const seed = useMutation({
    mutationFn: async () => { for (const s of SAMPLES) await api('POST', `/orgs/${org.id}/products`, { body: s, idempotencyKey: newKey() }); },
    onSuccess: () => { refresh(); toast({ kind: 'success', text: 'Added 4 sample products' }); },
    onError: (e: ApiError) => toast({ kind: 'error', text: e.message }),
  });

  function exportCsv() {
    const list = selected.size ? rows.filter((r) => selected.has(r.id)) : rows;
    const head = ['SKU', 'Name', 'Barcode', 'Unit', 'Price', 'Cost', 'On hand', 'Reserved', 'Reorder point', 'Tags', 'Status'];
    const lines = list.map((p) => [p.sku, p.name, p.barcode, p.unit, (p.priceMinor / 100).toFixed(2), p.costMinor == null ? '' : (p.costMinor / 100).toFixed(2), p.onHand, p.reserved, p.reorderPoint, p.tags.join(' '), p.status].map(csvCell).join(','));
    const blob = new Blob([[head.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <header className="top-header">
        <div className="breadcrumb">
          <span>Inventory</span>
          <Icon name="chevron" size={12} />
          <span className="current">Products</span>
        </div>
        <div className="header-actions">
          <div className="search-container">
            <input className="search-input" type="search" placeholder="Search name, SKU, barcode…" aria-label="Search products" value={text} onChange={(e) => setText(e.target.value)} />
            <Icon name="search" />
          </div>
          {write && <button className="btn btn-primary" onClick={openNew}><Icon name="plus" size={14} /> New</button>}
          {write && <button className="btn btn-ghost" onClick={() => openAdjust()}><Icon name="swap" size={14} /> Adjust</button>}
          <button className="btn btn-ghost" onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={14} /> {selected.size ? `Export ${selected.size}` : 'Export'}</button>
        </div>
      </header>

      <div className="orders-table-container">
        {query.isError ? (
          <div className="state"><Icon name="alert" size={28} /><h3>Could not load products</h3><p>{(query.error as ApiError).message}</p><button className="btn btn-primary" onClick={() => query.refetch()}>Try again</button></div>
        ) : query.isLoading || (rows.length === 0 && query.isFetching) ? (
          <table className="orders-table" aria-busy="true"><tbody>{Array.from({ length: 8 }, (_, i) => <tr key={i} className="skeleton-row"><td colSpan={8}><div className="skeleton" /></td></tr>)}</tbody></table>
        ) : rows.length === 0 ? (
          <div className="state">
            <Icon name="box" size={32} />
            {filtered ? (
              <><h3>No products match{filters.q ? ` “${filters.q}”` : ' these filters'}</h3><p>Try a different search or clear the filters.</p><button className="btn btn-primary" onClick={() => { setText(''); setParams({}, { replace: true }); }}>Clear filters</button></>
            ) : (
              <><h3>Your inventory is empty</h3><p>Add your first product, or load a few samples to explore.</p>
                {write && <div className="state-actions"><button className="btn btn-primary" onClick={openNew}><Icon name="plus" size={14} /> New product</button><button className="btn btn-outline" onClick={() => seed.mutate()} disabled={seed.isPending}>{seed.isPending ? 'Adding…' : 'Load sample data'}</button></div>}</>
            )}
          </div>
        ) : (
          <>
            <table className="orders-table products-table">
              <thead>
                <tr>
                  <th className="checkbox-col"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  <th className="icon-col" />
                  <th>Updated</th>
                  <th>Status</th>
                  <th>Product</th>
                  <th className="num">On hand</th>
                  <th className="num">Price</th>
                  <th className="actions-col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const { date, time } = dateParts(p.updatedAt);
                  const [cls, label] = STATUS[p.status];
                  return (
                    <tr key={p.id}>
                      <td className="checkbox-col"><input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} /></td>
                      <td className="icon-col"><div className={`order-icon ${avatarClass(p.name)}`}>{p.name.slice(0, 1).toUpperCase()}</div></td>
                      <td className="date-col"><div className="date">{date}</div><div className="time">{time}</div></td>
                      <td className="status-col"><span className={`status ${cls}`}>{label}</span></td>
                      <td className="items-col">
                        <div className="order-id">{p.sku}</div>
                        <button className="link-name" onClick={() => openEdit(p.id)}>{p.name}</button>
                        {p.tags.length > 0 && <div className="item-desc">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                      </td>
                      <td className="num"><div className="qty">{p.onHand}</div>{p.reserved > 0 && <div className="time">{p.reserved} reserved</div>}</td>
                      <td className="num">{money(p.priceMinor, org.currency)}</td>
                      <td className="actions-col row-actions">
                        {write && <button title="Adjust stock" aria-label={`Adjust stock of ${p.name}`} onClick={() => openAdjust(p.id)}><Icon name="swap" /></button>}
                        {write && <button title="Edit" aria-label={`Edit ${p.name}`} onClick={() => openEdit(p.id)}><Icon name="pencil" /></button>}
                        {write && <button title="Delete" aria-label={`Delete ${p.name}`} onClick={() => remove.mutate(p)}><Icon name="trash" /></button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="table-foot">
              <span>{rows.length} product{rows.length === 1 ? '' : 's'}{query.hasNextPage ? '+' : ''} shown</span>
              {query.hasNextPage && <button className="btn btn-outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
