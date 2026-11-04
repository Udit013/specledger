export type Shortcut = 'next' | 'previous' | 'accept' | 'edit' | 'reject' | 'help';

const KEYS: Readonly<Record<string, Shortcut>> = {
  j: 'next',
  k: 'previous',
  a: 'accept',
  e: 'edit',
  r: 'reject',
  '?': 'help',
};

export const SHORTCUT_HELP: readonly { readonly key: string; readonly action: string }[] = [
  { key: 'j', action: 'Next field' },
  { key: 'k', action: 'Previous field' },
  { key: 'a', action: 'Accept the selected field' },
  { key: 'e', action: 'Edit the selected field' },
  { key: 'r', action: 'Reject the selected field' },
  { key: '?', action: 'Show these shortcuts' },
  { key: 'Escape', action: 'Close a form or dialog' },
];

// The review action for a key press, or null. Presses with Ctrl, Meta or Alt are left to the
// browser, and a held key does not repeat an action.
export function shortcutFor(event: KeyboardEvent): Shortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  return KEYS[event.key] ?? null;
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'number',
  'password',
  'tel',
  'url',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

// Whether the key press is typing: shortcuts are off in text inputs, text areas, selects and
// editable content, so a reviewer can type "a" or "r" into a reason.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.contentEditable === 'true' ||
    target.getAttribute('contenteditable') === 'true'
  ) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}
