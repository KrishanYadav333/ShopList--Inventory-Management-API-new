import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Window-scroll virtualization for a table body with uniform rows.
 * Returns the slice to render plus top/bottom spacer heights. Below `threshold`
 * rows everything renders, so small lists behave exactly as before.
 * ponytail: assumes uniform row height (measured from the first row); variable rows need a measuring virtualizer.
 */
export function useVirtualRows(count: number, threshold = 80, overscan = 12) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [rowH, setRowH] = useState(0);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, threshold) });
  const on = count > threshold;

  useLayoutEffect(() => {
    if (!on) return;
    const first = bodyRef.current?.querySelector('tr:not(.spacer)');
    if (first) setRowH(first.getBoundingClientRect().height);
  }, [on, count > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!on || !rowH) return;
    let raf = 0;
    const calc = () => {
      raf = 0;
      const top = (bodyRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
      const first = Math.floor((window.scrollY - top) / rowH);
      const visible = Math.ceil(window.innerHeight / rowH);
      const start = Math.max(0, first - overscan);
      const end = Math.min(count, first + visible + overscan);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [on, rowH, count, overscan]);

  if (!on || !rowH) return { bodyRef, start: 0, end: count, before: 0, after: 0 };
  const end = Math.min(range.end, count);
  const start = Math.min(range.start, end);
  return { bodyRef, start, end, before: start * rowH, after: (count - end) * rowH };
}
