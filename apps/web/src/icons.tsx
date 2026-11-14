import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  cog: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  chevron: 'm9 6 6 6-6 6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  check: 'm5 12 5 5 9-10',
  alert: 'M12 4 2 20h20L12 4zM12 10v4M12 17h0',
  x: 'M6 6l12 12M18 6 6 18',
  scan: 'M4 8V5h3M17 4h3v3M20 16v3h-3M7 20H4v-3M7 8v8M11 8v8M15 8v8',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3zM9 12l2 2 4-4',
  cart: 'M3 4h2l2.4 11h11l2-8H6M9 20h0M17 20h0',
  truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19h0M17 19h0',
  printer: 'M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z',
  github: 'M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.600 3.600 0 0 1 .1-2.7s.8-.3 2.800 1a9.500 9.500 0 0 1 5 0c2-1.300 2.800-1 2.800-1 .5 1.400.2 2.400.1 2.700a3.900 3.900 0 0 1 1 2.700c0 3.900-2.400 4.700-4.600 5 .4.300.7.900.7 1.800v2.700c0 .3.2.6.7.5A10 10 0 0 0 12 2z',
};

export function Icon({ name, size = 16, ...rest }: { name: keyof typeof paths | string; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === 'github';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d={paths[name] ?? ''} />
    </svg>
  );
}
