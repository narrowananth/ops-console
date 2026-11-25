import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PastedFile } from '@ops-console/shared';
import type { CDPSession } from 'playwright-core';

/** The most the console takes of one selection. */
const MAX_SELECTION = 1_000_000;

/**
 * The page's selection as Chrome's copy would take it: the range of a focused text field (which `getSelection` does not
 * cover), else the document's selection, inside same-origin frames too. A password field gives nothing, as in Chrome.
 */
const READ_SELECTION = `(() => {
  let doc = document;
  let el = doc.activeElement;
  while (el && el.contentDocument) { doc = el.contentDocument; el = doc.activeElement; }
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    if (el.type === 'password') return '';
    if (typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd)
      return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return String(doc.getSelection() ?? '');
})()`;

const FOCUSED_FILE_FIELD = `(() => {
  const el = document.activeElement;
  return el && el.tagName === 'INPUT' && el.type === 'file' ? el : null;
})()`;

export async function readSelection(cdp: CDPSession): Promise<string> {
  const { result } = await cdp.send('Runtime.evaluate', { expression: READ_SELECTION, returnByValue: true });
  return typeof result.value === 'string' ? result.value.slice(0, MAX_SELECTION) : '';
}

/** Writes the files under a new folder, each in a folder of its own so equal names do not collide; returns the folder and paths. */
export async function stageFiles(files: PastedFile[]): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ops-console-paste-'));
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const folder = path.join(dir, String(index));
    await mkdir(folder);
    const target = path.join(folder, path.basename(file.name) || 'file');
    await writeFile(target, Buffer.from(file.data, 'base64'));
    paths.push(target);
  }
  return { dir, paths };
}

/** Gives the focused file field the files, as a pick would; false when the page has no file field focused. */
export async function fillFocusedFileField(cdp: CDPSession, paths: string[]): Promise<boolean> {
  const { result } = await cdp.send('Runtime.evaluate', { expression: FOCUSED_FILE_FIELD });
  if (!result.objectId) return false;
  const multiple = await cdp.send('Runtime.callFunctionOn', {
    objectId: result.objectId,
    functionDeclaration: 'function () { return this.multiple; }',
    returnByValue: true,
  });
  await cdp.send('DOM.setFileInputFiles', {
    objectId: result.objectId,
    files: multiple.result.value === true ? paths : paths.slice(0, 1),
  });
  return true;
}

/** Drops the files at a point of the page as a person dragging them from the desktop would. */
export async function dropFiles(cdp: CDPSession, paths: string[], x: number, y: number): Promise<void> {
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
}
