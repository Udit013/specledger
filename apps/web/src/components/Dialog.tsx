import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A modal dialog: focus moves into it when it opens, Tab stays inside it, Escape closes it, and
// focus returns to whatever had it before.
export function Dialog({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape is handled on the document, not only inside the dialog: focus can leave it (a button
  // that becomes disabled drops focus to the body) and the dialog must still close.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || ref.current === null) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="mt-16 max-h-[calc(100vh-6rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/5"
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
