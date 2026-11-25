import { expect, test } from '@playwright/test';
import { editingCommands, isComposingKey, keyMessage, pasteShortcut, typedText } from '../src/browser/input';

/** Encoding of the operator's keys for the Session browser: pure functions, no browser needed. */
const key = (key: string, code: string, extra: Partial<Record<string, boolean | number>> = {}) => ({
  key,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  ...extra,
});

test.describe('typed text', () => {
  test('is one character or Enter', () => {
    expect(typedText(key('a', 'KeyA'))).toBe('a');
    expect(typedText(key('😀', 'Unidentified'))).toBe('😀');
    expect(typedText(key('Enter', 'Enter'))).toBe('\r');
    expect(typedText(key('ArrowLeft', 'ArrowLeft'))).toBeUndefined();
    expect(typedText(key('Backspace', 'Backspace'))).toBeUndefined();
  });

  test('is none with Control or Command held', () => {
    expect(typedText(key('a', 'KeyA', { ctrlKey: true }))).toBeUndefined();
    expect(typedText(key('a', 'KeyA', { metaKey: true }))).toBeUndefined();
    expect(typedText(key('Enter', 'Enter', { metaKey: true }))).toBeUndefined();
  });

  test('is the typed character with Alt held, as on a Mac keyboard', () => {
    expect(typedText(key('å', 'KeyA', { altKey: true }))).toBe('å');
  });
});

test.describe('input method keys', () => {
  test('Process, Dead, keyCode 229 and a composing event belong to the method', () => {
    expect(isComposingKey(key('Process', 'KeyK'))).toBe(true);
    expect(isComposingKey(key('Dead', 'Quote'))).toBe(true);
    expect(isComposingKey(key('a', 'KeyA', { keyCode: 229 }))).toBe(true);
    expect(isComposingKey(key('a', 'KeyA', { isComposing: true }))).toBe(true);
    expect(isComposingKey(key('a', 'KeyA', { keyCode: 65 }))).toBe(false);
  });
});

test.describe('paste shortcuts', () => {
  test('Command+V on a Mac and Control+V elsewhere paste natively', () => {
    expect(pasteShortcut(key('v', 'KeyV', { metaKey: true }), true)).toBe('native');
    expect(pasteShortcut(key('v', 'KeyV', { ctrlKey: true }), false)).toBe('native');
  });

  test('Control+V on a Mac is read from the clipboard by hand, not swallowed', () => {
    expect(pasteShortcut(key('v', 'KeyV', { ctrlKey: true }), true)).toBe('clipboard');
  });

  test('a plain v, Alt+V and Command+V off a Mac are not pastes', () => {
    expect(pasteShortcut(key('v', 'KeyV'), true)).toBeNull();
    expect(pasteShortcut(key('v', 'KeyV', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(pasteShortcut(key('v', 'KeyV', { metaKey: true }), false)).toBe('native');
  });
});

test.describe('editing commands', () => {
  test('a plain key or letter has none, and Command keys mean nothing off a Mac', () => {
    expect(editingCommands(key('KeyA', 'KeyA'), true)).toEqual([]);
    expect(editingCommands(key('ArrowLeft', 'ArrowLeft'), true)).toEqual([]);
    expect(editingCommands(key('ArrowLeft', 'ArrowLeft', { shiftKey: true }), true)).toEqual([]);
    expect(editingCommands(key('a', 'KeyA', { metaKey: true }), false)).toEqual([]);
  });
});

test.describe('key messages', () => {
  test('carry the text, modifiers and commands of a press, and the repeat of a held key', () => {
    expect(keyMessage('down', key('a', 'KeyA'), true)).toEqual({
      type: 'key',
      action: 'down',
      key: 'a',
      code: 'KeyA',
      text: 'a',
      modifiers: 0,
    });
    expect(keyMessage('down', key('a', 'KeyA', { metaKey: true }), true)).toMatchObject({ modifiers: 4 });
    expect(keyMessage('down', key('a', 'KeyA', { metaKey: true }), true)).toHaveProperty('commands');
    expect(keyMessage('down', key('a', 'KeyA', { metaKey: true }), true)).not.toHaveProperty('text');
    expect(keyMessage('down', key('Backspace', 'Backspace', { repeat: true }), true)).toMatchObject({ repeat: true });
  });

  test('a release carries no text, commands or repeat', () => {
    const up = keyMessage('up', key('a', 'KeyA', { metaKey: true, repeat: true }), true);
    expect(up).toEqual({ type: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 4 });
  });
});
