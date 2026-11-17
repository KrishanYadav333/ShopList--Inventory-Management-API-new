import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

interface Notice { id: string; message: string; severity: 'info' | 'warning' }
interface Data { data: Notice[]; maintenance: { id: string; scope: 'platform' | 'business'; message: string }[] }
const KEY = 'shoplist.dismissed';
const read = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; } };

/** Notices from the owner (dismissible) and maintenance warnings (not dismissible: they explain why saving fails). */
export function Announcements() {
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api<Data>('GET', '/announcements'), refetchInterval: 60_000, staleTime: 30_000 });
  const [gone, setGone] = useState<string[]>(read);
  const dismiss = (id: string) => { const next = [...gone, id].slice(-50); setGone(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  const notices = (q.data?.data ?? []).filter((n) => !gone.includes(n.id));
  const maint = q.data?.maintenance ?? [];
  if (!notices.length && !maint.length) return null;
  return (
    <div className="announcements">
      {maint.map((m) => (
        <div key={m.id} className="banner banner-warn" role="status">
          <strong>{m.scope === 'platform' ? 'ShopList is being updated.' : 'This business is being updated.'}</strong> You can look around, but nothing can be saved right now. {m.message}
        </div>
      ))}
      {notices.map((n) => (
        <div key={n.id} className={`banner ${n.severity === 'warning' ? 'banner-warn' : 'banner-info'}`} role="status">
          {n.message}
          <button className="btn btn-outline" onClick={() => dismiss(n.id)} aria-label="Dismiss this notice">Dismiss</button>
        </div>
      ))}
    </div>
  );
}
