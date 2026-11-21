import type { ReactNode } from 'react';

/** Small line icons for the Session page's header and side card; each is 16px and takes the text colour. */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="flex-none"
    >
      {children}
    </svg>
  );
}

export const GlobeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
  </Icon>
);

export const TerminalIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="m7.5 9.5 3 2.5-3 2.5M13 15h4" />
  </Icon>
);

export const BranchIcon = () => (
  <Icon>
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="8" r="2" />
    <path d="M6 7.5v9M18 10c0 4-6 3-12 7" />
  </Icon>
);

export const PullRequestIcon = () => (
  <Icon>
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="18.5" r="2" />
    <path d="M6 7.5v9M18 16.5V9a3 3 0 0 0-3-3h-3m2-2.5-2 2.5 2 2.5" />
  </Icon>
);

export const DiffIcon = () => (
  <Icon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M9.5 12.5h5M12 10v5M9.5 17.5h5" />
  </Icon>
);

export const PanelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M15 4v16" />
  </Icon>
);

export const AgentIcon = () => (
  <Icon>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 4v4M9 13.5v1M15 13.5v1" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5h4" />
  </Icon>
);

export const BookIcon = () => (
  <Icon>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15ZM5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
  </Icon>
);

export const ChevronIcon = ({ open = false }: { open?: boolean }) => (
  <span className={`inline-flex transition-transform ${open ? 'rotate-180' : ''}`}>
    <Icon size={14}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  </span>
);

export const LaptopIcon = () => (
  <Icon>
    <rect x="5" y="5" width="14" height="10" rx="1.5" />
    <path d="M3 19h18" />
  </Icon>
);

export const FolderIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

/** The Visual Studio Code mark, in its own blue. */
export const VsCodeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="flex-none">
    <path
      fill="#2f8ad8"
      d="M17.6 2.3 9.9 9.4 5.3 5.9 3.5 6.8v10.4l1.8.9 4.6-3.5 7.7 7.1 3-1.4V3.7l-3-1.4ZM5.4 15V9l3 3-3 3Zm12.2.4-5.2-3.4 5.2-3.4v6.8Z"
    />
  </svg>
);

export const CommitIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </Icon>
);

export const PushIcon = () => (
  <Icon>
    <path d="M7 17.5H6a4 4 0 0 1-.6-7.96A6 6 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9H17M12 20v-8M9 14.5l3-3 3 3" />
  </Icon>
);

export const CheckCircleIcon = ({ tone }: { tone: string }) => (
  <span className={tone}>
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </Icon>
  </span>
);

export const CrossCircleIcon = ({ tone }: { tone: string }) => (
  <span className={tone}>
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </Icon>
  </span>
);

/** `</>`, for Inspect. */
export const CodeIcon = () => (
  <Icon>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 5l-4 14" />
  </Icon>
);

/** An arrow leaving a box, for "Open in your browser". */
export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);

/** A cookie with a bite out of it and a small x, for clearing a Session's cookies. */
export const CookieIcon = () => (
  <Icon>
    <path d="M9.5 3a6.5 6.5 0 1 0 6.5 6.5 3 3 0 0 1-3-3 3 3 0 0 1-3.5-3.5Z" />
    <path d="M6.8 8.2h.01M8.2 12h.01M11.8 11h.01" />
    <path d="m16.5 16.5 4.5 4.5m0-4.5-4.5 4.5" />
  </Icon>
);

/** A pointer arrow, for picking an element on the page. */
export const PointerIcon = () => (
  <Icon>
    <path d="m5 3 14 7.5-6 1.8-1.8 6.2L5 3Z" />
  </Icon>
);

/** DevTools' own dock-side pictures: a window of its own, the bottom, the right. */
export const DockWindowIcon = () => (
  <Icon>
    <rect x="8" y="3" width="13" height="13" rx="2" />
    <path d="M16 20.5H5a2 2 0 0 1-2-2V8" />
  </Icon>
);

export const DockBottomIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 14h18" />
  </Icon>
);

export const DockRightIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M14.5 4v16" />
  </Icon>
);

export const DotCircleIcon = ({ tone }: { tone: string }) => (
  <span className={tone}>
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
    </Icon>
  </span>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const PencilIcon = () => (
  <Icon>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 7.5l3 3" />
  </Icon>
);

export const SparkleIcon = () => (
  <Icon>
    <path d="M10 4.5 11.8 9.2 16.5 11 11.8 12.8 10 17.5 8.2 12.8 3.5 11 8.2 9.2 10 4.5ZM18 3.5v4M16 5.5h4M18 15v4M16 17h4" />
  </Icon>
);

export const ShieldOffIcon = () => (
  <Icon>
    <path d="M12 3 5 6v5.5c0 4.2 2.8 7.4 7 9 1.6-.6 3-1.4 4.1-2.5M19 11.5V6l-7-3-2.2.9M3 3l18 18" />
  </Icon>
);
