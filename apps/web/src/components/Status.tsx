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
    neutral: 'border-slate-400 text-slate-800',
    good: 'border-green-700 text-green-900',
    warn: 'border-amber-700 text-amber-900',
    bad: 'border-red-700 text-red-900',
  }[tone];
  return (
    <span
      className={`inline-flex w-36 items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${colors}`}
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
        <div key={row} aria-hidden="true" className="h-6 animate-pulse rounded bg-slate-200" />
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
    <div role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-semibold">{title}</p>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-700 px-2 py-1 font-medium"
        >
          Try again
        </button>
      )}
    </div>
  );
}
