import { describe, expect, it } from 'vitest';

import { isTypingTarget, shortcutFor } from './shortcuts.js';

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key: k, ...extra });

describe('shortcutFor', () => {
  it.each([
    ['j', 'next'],
    ['k', 'previous'],
    ['a', 'accept'],
    ['e', 'edit'],
    ['r', 'reject'],
    ['?', 'help'],
  ])('maps %s to %s', (k, action) => {
    expect(shortcutFor(key(k))).toBe(action);
  });

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['alt', { altKey: true }],
  ])('ignores a key pressed with %s, so browser shortcuts keep working', (_name, init) => {
    expect(shortcutFor(key('r', init))).toBeNull();
  });

  it('ignores other keys, capitals and repeats', () => {
    expect(shortcutFor(key('x'))).toBeNull();
    expect(shortcutFor(key('J', { shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('a', { repeat: true }))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it.each(['input', 'textarea', 'select'])('is true for a %s', (tag) => {
    expect(isTypingTarget(document.createElement(tag))).toBe(true);
  });

  it('is true for editable content and false for buttons and plain elements', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('is false for inputs that take no text, such as a radio button', () => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    expect(isTypingTarget(radio)).toBe(false);
  });
});
