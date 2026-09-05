// SVG icon components — ported from design handoff Icons.jsx

type IconProps = {
  size?: number;
  className?: string;
};

function Icon({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  dashboard: (p: IconProps = {}) => <Icon {...p}><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></Icon>,
  clients: (p: IconProps = {}) => <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></Icon>,
  articles: (p: IconProps = {}) => <Icon {...p}><path d="M5 3h11l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M16 3v4h3M8 11h8M8 15h8M8 19h5"/></Icon>,
  keywords: (p: IconProps = {}) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Icon>,
  calendar: (p: IconProps = {}) => <Icon {...p}><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></Icon>,
  backlinks: (p: IconProps = {}) => <Icon {...p}><path d="M10 14 14 10"/><path d="M9 7h-2a5 5 0 0 0 0 10h2"/><path d="M15 17h2a5 5 0 0 0 0-10h-2"/></Icon>,
  voice: (p: IconProps = {}) => <Icon {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></Icon>,
  integrations: (p: IconProps = {}) => <Icon {...p}><path d="M3 7h6v6H3zM15 7h6v6h-6zM9 17h6v4H9zM12 13v4M6 13v4l3 0M18 13v4l-3 0"/></Icon>,
  reports: (p: IconProps = {}) => <Icon {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></Icon>,
  team: (p: IconProps = {}) => <Icon {...p}><circle cx="9" cy="8" r="4"/><circle cx="17" cy="10" r="3"/><path d="M3 21c0-4 3-6 6-6s6 2 6 6M14 21c0-3 2-4 3-4s3 1 3 4"/></Icon>,
  billing: (p: IconProps = {}) => <Icon {...p}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></Icon>,
  signOut: (p: IconProps = {}) => <Icon {...p}><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M15 12H4m11 0-4-4m4 4-4 4" transform="translate(5 0)"/></Icon>,
  settings: (p: IconProps = {}) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></Icon>,
  plus: (p: IconProps = {}) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  search: (p: IconProps = {}) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Icon>,
  filter: (p: IconProps = {}) => <Icon {...p}><path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z"/></Icon>,
  sort: (p: IconProps = {}) => <Icon {...p}><path d="M8 4v16m0 0-4-4m4 4 4-4M16 20V4m0 0-4 4m4-4 4 4"/></Icon>,
  more: (p: IconProps = {}) => <Icon {...p}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></Icon>,
  check: (p: IconProps = {}) => <Icon {...p}><path d="M5 12.5 10 17 19 7"/></Icon>,
  x: (p: IconProps = {}) => <Icon {...p}><path d="M6 6l12 12M18 6L6 18"/></Icon>,
  arrow: (p: IconProps = {}) => <Icon {...p}><path d="M5 12h14m0 0-6-6m6 6-6 6"/></Icon>,
  arrowLeft: (p: IconProps = {}) => <Icon {...p}><path d="M19 12H5m0 0 6-6m-6 6 6 6"/></Icon>,
  caretDown: (p: IconProps = {}) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>,
  caretUpDown: (p: IconProps = {}) => <Icon {...p}><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></Icon>,
  bell: (p: IconProps = {}) => <Icon {...p}><path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3v-4Z"/><path d="M10 20a2 2 0 0 0 4 0"/></Icon>,
  // Feedback, not help. They were the same icon, and the floating button
  // that sends an email looked like the one that explains the product.
  message: (p: IconProps = {}) => <Icon {...p}><path d="M4 5h16v11H9l-5 4V5Z"/></Icon>,
  help: (p: IconProps = {}) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01"/></Icon>,
  sparkle: (p: IconProps = {}) => <Icon {...p}><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5ZM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></Icon>,
  globe: (p: IconProps = {}) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></Icon>,
  link: (p: IconProps = {}) => <Icon {...p}><path d="M10 14 14 10"/><path d="M9 7h-2a5 5 0 0 0 0 10h2"/><path d="M15 17h2a5 5 0 0 0 0-10h-2"/></Icon>,
  upload: (p: IconProps = {}) => <Icon {...p}><path d="M12 3v14m0-14-5 5m5-5 5 5M5 21h14"/></Icon>,
  download: (p: IconProps = {}) => <Icon {...p}><path d="M12 3v14m0 0-5-5m5 5 5-5M5 21h14"/></Icon>,
  eye: (p: IconProps = {}) => <Icon {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></Icon>,
  edit: (p: IconProps = {}) => <Icon {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></Icon>,
  trend: (p: IconProps = {}) => <Icon {...p}><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></Icon>,
  externalLink: (p: IconProps = {}) => <Icon {...p}><path d="M14 3h5v5M20 4 10 14M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></Icon>,
  refresh: (p: IconProps = {}) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></Icon>,
  bold: (p: IconProps = {}) => <Icon {...p}><path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z"/></Icon>,
  italic: (p: IconProps = {}) => <Icon {...p}><path d="M19 4h-9M14 20H5M15 4 9 20"/></Icon>,
  h1: (p: IconProps = {}) => <Icon {...p}><path d="M4 6v12M14 6v12M4 12h10M20 18V7l-3 3"/></Icon>,
  list: (p: IconProps = {}) => <Icon {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></Icon>,
  // Planner card actions: brief, questions, remove.
  lightbulb: (p: IconProps = {}) => <Icon {...p}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/></Icon>,
  question: (p: IconProps = {}) => <Icon {...p}><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M10.5 9a1.5 1.5 0 0 1 3 0c0 1.2-1.5 1.2-1.5 2.4M12 14h.01"/></Icon>,
  trash: (p: IconProps = {}) => <Icon {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></Icon>,
};

export type IconName = keyof typeof Icons;
