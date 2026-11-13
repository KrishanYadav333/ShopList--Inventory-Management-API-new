import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Product } from '@shoplist/shared';
import { api } from '../api';
import { canWrite, type OrgSummary } from '../queries';
import { Modal } from './Modal';

interface Cmd { id: string; label: string; hint?: string; run: () => void }

export function CommandPalette({ org, onClose, onNew, onAdjust, onEdit }: { org: OrgSummary; onClose: () => void; onNew: () => void; onAdjust: (id?: string) => void; onEdit: (id: string) => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const products = useQuery({
    queryKey: ['org', org.id, 'palette', q],
    enabled: q.trim().length > 0,
    queryFn: () => api<{ data: Product[] }>('GET', `/orgs/${org.id}/products?limit=6&q=${encodeURIComponent(q.trim())}`),
  });
  const go = (path: string) => () => { nav(`/o/${org.id}/${path}`); onClose(); };
  const base: Cmd[] = [
    { id: 'p', label: 'Go to Products', run: go('products') },
    { id: 'h', label: 'Go to Stock history', run: go('history') },
    { id: 's', label: 'Go to Settings', run: go('settings') },
    ...(canWrite(org.role) ? [
      { id: 'n', label: 'New product', hint: 'N', run: () => { onClose(); onNew(); } },
      { id: 'a', label: 'Adjust stock', run: () => { onClose(); onAdjust(); } },
    ] : []),
  ];
  const text = q.trim().toLowerCase();
  const cmds: Cmd[] = [
    ...base.filter((c) => !text || c.label.toLowerCase().includes(text)),
    ...(products.data?.data ?? []).flatMap((p): Cmd[] => [
      { id: `e-${p.id}`, label: `Open ${p.name}`, hint: p.sku, run: () => { onClose(); onEdit(p.id); } },
      ...(canWrite(org.role) ? [{ id: `a-${p.id}`, label: `Adjust stock: ${p.name}`, hint: `${p.onHand} on hand`, run: () => { onClose(); onAdjust(p.id); } }] : []),
    ]),
  ];
  useEffect(() => setActive(0), [q]);

  return (
    <Modal title="Command palette" onClose={onClose}>
      <div className="palette">
        <input
          className="palette-input" placeholder="Type a command or search products…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search commands"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, cmds.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') cmds[active]?.run();
          }}
        />
        <ul className="results" role="listbox">
          {cmds.map((c, i) => (
            <li key={c.id}><button type="button" role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onClick={c.run}><strong>{c.label}</strong>{c.hint && <span>{c.hint}</span>}</button></li>
          ))}
          {!cmds.length && <li className="results-empty">No matches.</li>}
        </ul>
      </div>
    </Modal>
  );
}
