import { notImplemented } from './not-implemented.js';
export type Shortcut = 'next' | 'previous' | 'accept' | 'edit' | 'reject' | 'help';
export function shortcutFor(event: KeyboardEvent): Shortcut | null {
  return notImplemented(`shortcutFor(${event.key})`);
}
export function isTypingTarget(target: EventTarget | null): boolean {
  return notImplemented(`isTypingTarget(${target === null ? 'null' : 'target'})`);
}
