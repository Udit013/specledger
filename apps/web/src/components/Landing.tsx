import type { Mode } from '../context.js';
import { hrefFor } from '../lib/router.js';
import { Icon } from './Icons.js';
import { Spinner } from './Status.js';
import type { IconName } from './Icons.js';

const REPOSITORY = 'https://github.com/Udit013/specledger';

const STEPS: readonly { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'upload',
    title: 'Upload',
    text: 'Vendor datasheets, manuals and brochures go in as PDFs. Each one is parsed in a sandbox and queued.',
  },
  {
    icon: 'extract',
    title: 'Extract',
    text: 'A language model reads every page and proposes values, each with the exact quote and page it came from.',
  },
  {
    icon: 'verify',
    title: 'Verify',
    text: 'Deterministic rules check that the quote is on the page and states the value, the unit and the right label.',
  },
  {
    icon: 'conflict',
    title: 'Reconcile',
    text: 'Values for the same equipment are compared across documents. Later revisions and stronger sources win; real disagreements become conflicts.',
  },
  {
    icon: 'review',
    title: 'Review',
    text: 'An engineer accepts, edits or rejects each value next to its highlighted source, and resolves conflicts with a reason.',
  },
  {
    icon: 'publish',
    title: 'Publish and hand off',
    text: 'An approver publishes an immutable, numbered equipment register: downloadable as CSV or JSON and shaped for an asset system, with every change in the audit log.',
  },
];

const TRY: readonly { title: string; text: string }[] = [
  {
    title: 'Check a value against its source',
    text: 'Open p-106-datasheet.pdf and step through the fields with j and k; the quote behind each value is highlighted on the page.',
  },
  {
    title: 'Watch a prompt injection fail',
    text: 'p-108-datasheet.pdf tells “automated extraction systems” to report a false flow. A value the page does not support stays Unverified.',
  },
  {
    title: 'Resolve a conflict between sources',
    text: 'Reject the datasheet’s rated head for P-106: the brochure disagrees, so a conflict opens for a person to decide instead of a silent fallback.',
  },
  {
    title: 'Publish, then follow the handoff',
    text: 'Publishing is refused, with the exact list of blockers, until every value is reviewed and every conflict resolved. Then open the version under Register: download it, and preview the requests an asset-system sync would send.',
  },
];

const PROBLEMS: readonly { title: string; text: string; answer: string }[] = [
  {
    title: 'Re-keyed by hand',
    text: 'Values are copied from PDFs into spreadsheets and asset systems, one field at a time, by whoever has the time.',
    answer:
      'a model extracts every field, and a person only confirms or corrects it beside the source.',
  },
  {
    title: 'Superseded without notice',
    text: 'A revised datasheet changes a rating; a brochure says something else. The old number lives on downstream.',
    answer:
      'revisions and sources are ranked by explicit rules, and real disagreements wait for a decision.',
  },
  {
    title: 'Impossible to trace',
    text: 'Months later, nobody can say which page a number came from, or who accepted it and why.',
    answer:
      'every value keeps its quote and page, every decision its author and reason, and published versions never change.',
  },
];

export function Landing({
  mode,
  starting,
  startError,
  onTryDemo,
}: {
  readonly mode: Mode;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly onTryDemo: () => void;
}) {
  return (
    <div className="space-y-20 pb-8">
      <section aria-labelledby="home-heading" className="pt-6 sm:pt-12">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Equipment data for capital projects, with the evidence attached</p>
          <h2
            id="home-heading"
            className="mt-3 text-4xl font-bold tracking-tight text-balance text-ink sm:text-5xl"
          >
            Turn vendor datasheets into equipment data you can trust
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-pretty text-slate-600">
            SpecLedger reads vendor PDFs with an AI model, refuses any value it cannot find on the
            page, flags documents that disagree, and lets engineers publish a reviewed, versioned
            equipment register that downstream teams and tools can rely on.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {mode === 'demo' ? (
              <a href={hrefFor({ name: 'documents' })} className="btn btn-primary btn-lg">
                Continue in your sandbox
                <Icon name="arrow" className="h-5 w-5" />
              </a>
            ) : (
              <button
                type="button"
                aria-disabled={starting}
                onClick={() => {
                  if (!starting) onTryDemo();
                }}
                className="btn btn-primary btn-lg"
              >
                {starting ? <Spinner className="h-5 w-5" /> : null}
                {starting ? 'Preparing your sandbox…' : 'Try it yourself'}
                {starting ? null : <Icon name="arrow" className="h-5 w-5" />}
              </button>
            )}
            {mode === 'account' ? (
              <a href={hrefFor({ name: 'documents' })} className="btn btn-secondary btn-lg">
                Open your workspace
              </a>
            ) : (
              <a href={hrefFor({ name: 'documents' })} className="btn btn-secondary btn-lg">
                Browse the showcase
              </a>
            )}
          </div>
          <p className="mt-4 text-sm text-slate-600">
            No account needed. <strong className="font-semibold">Try it yourself</strong> gives you
            a private sandbox to review, resolve conflicts and publish; nobody else sees it and it
            is deleted when your session ends. Have a workspace account?{' '}
            <a href={hrefFor({ name: 'sign_in' })} className="link">
              Sign in
            </a>
            .
          </p>
          {startError === null ? null : (
            <div role="alert" className="notice notice-error mx-auto mt-4 max-w-xl text-left">
              {startError}
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="problem-heading">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">The problem</p>
          <h2 id="problem-heading" className="mt-2 text-3xl font-semibold tracking-tight">
            Equipment data is lost between documents and systems
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            On a capital project such as a process plant or a mine, every pump, motor and vessel
            arrives with vendor documents. The numbers in them feed design, procurement,
            construction and, later, maintenance.
          </p>
        </div>
        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {PROBLEMS.map((problem) => (
            <li key={problem.title} className="card p-6">
              <h3 className="font-semibold">{problem.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{problem.text}</p>
              <p className="mt-3 text-sm leading-relaxed">
                <span className="font-semibold text-brand-800">SpecLedger: </span>
                {problem.answer}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="how-heading">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">How it works</p>
          <h2 id="how-heading" className="mt-2 text-3xl font-semibold tracking-tight">
            From PDF to published register in six steps
          </h2>
        </div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="card p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <Icon name={step.icon} />
                </span>
                <span className="text-sm font-semibold text-slate-500">Step {index + 1}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="principles-heading"
        className="card grid gap-8 p-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
      >
        <div>
          <p className="eyebrow">Why it is built this way</p>
          <h2 id="principles-heading" className="mt-2 text-2xl font-semibold tracking-tight">
            The model proposes. The rules check. A person decides.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            A wrong number in an equipment register can mean the wrong pump on site. SpecLedger
            treats the model as a fast, fallible reader: useful, never trusted on its own.
          </p>
        </div>
        <ul className="grid gap-5 sm:grid-cols-2">
          {(
            [
              ['verify', 'Evidence for every value', 'Each value carries its quote and page.'],
              [
                'shield',
                'Untrusted documents',
                'Document text is data: instructions in a PDF cannot change what is accepted.',
              ],
              [
                'conflict',
                'No silent overrides',
                'Disagreements between documents wait for a human decision.',
              ],
              [
                'history',
                'A complete audit trail',
                'Who changed what, when and why; published versions never change.',
              ],
            ] as const
          ).map(([icon, title, text]) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 text-brand-700">
                <Icon name={icon} />
              </span>
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="mt-1 block text-sm text-slate-600">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="try-heading">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">In the demo</p>
          <h2 id="try-heading" className="mt-2 text-3xl font-semibold tracking-tight">
            Four things to try
          </h2>
          <p className="mt-3 text-sm text-slate-600">
            The demo workspace starts with seven synthetic pump and motor datasheets, extracted by a
            real model (Gemini), so values can differ from run to run. Your sandbox is a private
            copy; what you do there touches no one else.
          </p>
        </div>
        <ol className="mt-10 grid gap-4 md:grid-cols-2">
          {TRY.map((item, index) => (
            <li key={item.title} className="card flex gap-4 p-6">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-white">
                {index + 1}
              </span>
              <span>
                <span className="block font-semibold">{item.title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-slate-600">
                  {item.text}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="border-t border-slate-200 pt-8 text-sm text-slate-600">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p>
            SpecLedger is a portfolio project. Documents are synthetic; the ACC-style export is
            tested against a mock, not a real asset system.
          </p>
          <a href={REPOSITORY} className="link" rel="noreferrer" target="_blank">
            Source and documentation on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
