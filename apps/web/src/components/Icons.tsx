// Small line icons drawn inline (the Content-Security-Policy allows no external images). They
// are decorative: every one sits next to text that says the same thing.
const PATHS = {
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  extract: 'M4 6h16M4 12h10M4 18h7m9-4-3 3-1.5-1.5',
  verify: 'M9 12l2 2 4-4m5 2a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  conflict:
    'M12 9v4m0 3h.01M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  review: 'M15.2 5.2l3.6 3.6M4 20h4L19 9a2.5 2.5 0 0 0-3.6-3.6L4.5 16.5 4 20Z',
  publish: 'M12 3l7 4v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V7l7-4Zm-3 9 2 2 4-4',
  document: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6M9 17h4',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  shield: 'M12 3l7 4v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V7l7-4Z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// The SpecLedger mark: a ledger page with a check.
export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className}>
      <rect width="32" height="32" rx="8" fill="#2e44b4" />
      <path
        d="M10 8h9l4 4v12a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
        fill="#ffffff"
        opacity="0.95"
      />
      <path
        d="m12.5 18 2.5 2.5 5-5"
        fill="none"
        stroke="#2e44b4"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
