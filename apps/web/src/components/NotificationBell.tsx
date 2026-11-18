import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { dateParts } from '../format';
import { Icon } from '../icons';

interface Note { id: string; kind: string; title: string; link: string | null; createdAt: string; readAt: string | null }

/** Bell with an unread count. Checks once a minute while the page is visible; no sockets needed. */
export function NotificationBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api<{ count: number }>('GET', '/me/notifications/unread-count').then((r) => r.count),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const list = useQuery({ enabled: open, queryKey: ['notifications', 'list'], queryFn: () => api<{ data: Note[] }>('GET', '/me/notifications?limit=30').then((r) => r.data) });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api('POST', '/me/notifications/read', { body: ids ? { ids } : {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);

  const n = count.data ?? 0;
  return (
    <div className="bell" ref={box}>
      <button className="nav-item" title="Notifications" aria-label={n ? `Notifications, ${n} unread` : 'Notifications'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" size={18} />
        <span className="nav-label">Notifications</span>
        {n > 0 && <span className="bell-badge" aria-hidden="true">{n > 9 ? '9+' : n}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head"><strong>Notifications</strong>{n > 0 && <button className="link-name" onClick={() => markRead.mutate(undefined)}>Mark all read</button>}</div>
          {!list.data?.length ? <p className="hint">{list.isLoading ? 'Loading…' : 'Nothing yet. Low stock, new orders and approvals will show up here.'}</p> : (
            <ul className="bell-list">
              {list.data.map((x) => {
                const { date, time } = dateParts(x.createdAt);
                return (
                  <li key={x.id} className={x.readAt ? '' : 'unread'}>
                    <button onClick={() => { markRead.mutate([x.id]); setOpen(false); if (x.link) nav(x.link); }}>
                      <span>{x.title}</span><span className="time">{date} {time}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
