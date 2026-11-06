// A status as a symbol and words in a fixed-width box, so a changing status never moves the
// layout and never depends on color alone. The symbol is decorative; the words are read.
export function Status({
  text,
  symbol,
  tone,
}: {
  readonly text: string;
  readonly symbol: string;
  readonly tone: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const colors = {
    neutral: 'bg-slate-50 text-slate-700 ring-slate-300',
    good: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30',
    warn: 'bg-amber-50 text-amber-900 ring-amber-600/40',
    bad: 'bg-red-50 text-red-800 ring-red-600/30',
  }[tone];
  return (
    <span
      className={`inline-flex w-32 items-center gap-1.5 rounded-full sm:w-36 px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${colors}`}
    >
      <span aria-hidden="true">{symbol}</span>
      <span>{text}</span>
    </span>
  );
}

export function Loading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2 py-2">
      <span className="sr-only">{label}…</span>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          aria-hidden="true"
          className="h-11 animate-pulse rounded-xl bg-slate-200/70"
        />
      ))}
    </div>
  );
}

export function ErrorNotice({
  title,
  error,
  onRetry,
}: {
  readonly title: string;
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="notice notice-error">
      <p className="font-semibold">{title}</p>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button type="button" onClick={onRetry} className="btn btn-danger mt-3">
          Try again
        </button>
      )}
    </div>
  );
}
