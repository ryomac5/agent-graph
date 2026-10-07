import type { SVGProps } from 'react';

// 線のアイコンの組。24 の格子に 1.75 の線で描き、色は文字の色に従う。
const PATHS = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
  inbox: <><path d="M3.5 13.5h5l1.5 3h4l1.5-3h5"/><path d="M5.6 5.8 3.5 13.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4l-2.1-7.7a2 2 0 0 0-1.9-1.3H7.5a2 2 0 0 0-1.9 1.3Z"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>,
  bell: <><path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-2.5 8-2.5 8h17S18 15 18 8.5Z"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.5h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>,
  folderOpen: <><path d="M3.5 17V7.5a2 2 0 0 1 2-2h3.6l2 2.5h6.4a2 2 0 0 1 2 2v1"/><path d="M3.5 17.5 6.2 11.6a1.6 1.6 0 0 1 1.5-1h12.4a1 1 0 0 1 .9 1.4l-2.6 6.1a1.6 1.6 0 0 1-1.5 1H5a1.5 1.5 0 0 1-1.5-1.6Z"/></>,
  branch: <><circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5c0 4-5 3.5-9.6 7.5"/></>,
  fork: <><circle cx="6" cy="5.5" r="2"/><circle cx="18" cy="5.5" r="2"/><circle cx="12" cy="18.5" r="2"/><path d="M6 7.5v1.5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.5"/><path d="M12 12v4.5"/></>,
  chevronRight: <path d="m9.5 6 6 6-6 6"/>,
  chevronDown: <path d="m6 9.5 6 6 6-6"/>,
  chevronLeft: <path d="m14.5 6-6 6 6 6"/>,
  terminal: <><path d="m5 7.5 4.5 4.5L5 16.5"/><path d="M12 17h7"/></>,
  tool: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2l-5.6 5.6a1.5 1.5 0 0 0 2.1 2.1l5.6-5.6a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.1-.4-.4-2.1Z"/>,
  file: <><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M14 3.5v5h5"/></>,
  diff: <><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M9.5 11h5M12 8.5v5M9.5 16.5h5"/></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5"/>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.75"/><path d="m20.5 16-5-5-8.5 8.5"/></>,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>,
  send: <><path d="M12 19V5.5"/><path d="m6 11 6-6 6 6"/></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  alert: <><path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17h.01"/></>,
  unknown: <><path d="M12 3.5a8.5 8.5 0 0 1 0 17" strokeDasharray="2.6 2.6"/><path d="M12 20.5a8.5 8.5 0 0 1 0-17" strokeDasharray="2.6 2.6"/><path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 2-2.2 3.2M12 16.5h.01"/></>,
  message: <path d="M5.5 18.5 3.5 20.5V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2Z"/>,
  user: <><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></>,
  bot: <><rect x="4.5" y="7.5" width="15" height="11.5" rx="3"/><path d="M12 4v3.5M9.5 12.5v1.5M14.5 12.5v1.5"/></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></>,
  cpu: <><rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/></>,
  sparkle: <path d="M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8Z"/>,
  logo: <><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.3 7.2 15.7 10.8M8.3 16.8l7.4-3.6M6 8.5v7"/></>,
  external: <><path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></>,
  filter: <path d="M4 5.5h16l-6.2 7.2v5.6l-3.6 1.9v-7.5Z"/>,
  play: <path d="M7.5 5.5v13l11-6.5Z"/>,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>,
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, ...props }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return <svg className={className ? `icon ${className}` : 'icon'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{PATHS[name]}</svg>;
}
