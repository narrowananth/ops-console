import type { PrComment, PrFile, PullRequestDetail } from '@ops-console/shared';
import { ascending } from '../lib/sort';
import { lastOf } from './pr-jobs';

/** A thread: its root comment, then the replies, oldest first. */
export type ThreadData = { root: PrComment; replies: PrComment[] };

export function threadsOf(pr: PullRequestDetail): ThreadData[] {
  const replies = new Map<string, PrComment[]>();
  for (const comment of pr.comments) {
    if (comment.parent_id !== null)
      replies.set(comment.parent_id, [...(replies.get(comment.parent_id) ?? []), comment]);
  }
  return pr.comments
    .filter((comment) => comment.parent_id === null)
    .map((root) => ({
      root,
      replies: (replies.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }));
}

/** The time a thread last moved. */
export const threadTime = (thread: ThreadData) => lastOf(thread.root, thread.replies).created_at;

/** The agent started the thread or replied in it. */
export const agentInThread = (thread: ThreadData) =>
  thread.root.by_agent || thread.replies.some((reply) => reply.by_agent);

/** Check reply: the thread has a reply and its last comment is not the agent's. */
export const canCheck = (thread: ThreadData) =>
  thread.replies.length > 0 && !lastOf(thread.root, thread.replies).by_agent;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The new-side line numbers the file's diff holds. */
export function newSideLines(file: PrFile): Set<number> {
  const found = new Set<number>();
  let next = 0;
  for (const line of file.lines) {
    const hunk = line.sign === ' ' ? HUNK.exec(line.text) : null;
    if (hunk) next = Number(hunk[2]);
    else if (line.sign !== '-') found.add(next++);
  }
  return found;
}

/**
 * The Git host's own flag when it gives one; otherwise a comment on a file that left the pull request or on a line the
 * newest diff does not hold. A comment on no line is never outdated.
 */
export function isOutdated(files: PrFile[], root: PrComment): boolean {
  if (root.outdated !== null) return root.outdated;
  if (root.file_path === null || root.line === null) return false;
  const file = files.find((candidate) => candidate.name === root.file_path);
  return file === undefined || !newSideLines(file).has(root.line);
}

export type HunkRow = { header: boolean; sign: '+' | '-' | ' '; number: number | null; text: string; marked: boolean };

/** How many lines of a hunk the card shows: the ones above the commented line, and that line. */
const HUNK_TAIL = 5;

/** The tail of a diff hunk: its header, then the last lines up to the commented one, which is marked. */
export function hunkRows(hunk: string): HunkRow[] {
  const rows: HunkRow[] = [];
  let old = 0;
  let next = 0;
  let header: HunkRow | null = null;
  for (const text of hunk.replace(/\n$/, '').split('\n')) {
    const at = HUNK.exec(text);
    if (at) {
      old = Number(at[1]);
      next = Number(at[2]);
      header = { header: true, sign: ' ', number: null, text, marked: false };
      rows.length = 0;
    } else if (text.startsWith('+'))
      rows.push({ header: false, sign: '+', number: next++, text: text.slice(1), marked: false });
    else if (text.startsWith('-'))
      rows.push({ header: false, sign: '-', number: old++, text: text.slice(1), marked: false });
    else {
      old++;
      rows.push({ header: false, sign: ' ', number: next++, text: text.slice(1), marked: false });
    }
  }
  const tail = rows.slice(-HUNK_TAIL);
  const last = tail.at(-1);
  if (last) last.marked = true;
  return header ? [header, ...tail] : tail;
}

export type TreeEntry =
  | { kind: 'folder'; path: string; name: string; depth: number }
  | { kind: 'file'; file: PrFile; name: string; depth: number };

/** Folders before files at every level, each A to Z. */
export function fileTree(files: PrFile[]): TreeEntry[] {
  type Node = { folders: Map<string, Node>; files: PrFile[] };
  const root: Node = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.name.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      const child = at.folders.get(part) ?? { folders: new Map(), files: [] };
      at.folders.set(part, child);
      at = child;
    }
    at.files.push(file);
  }
  const out: TreeEntry[] = [];
  const walk = (node: Node, path: string, depth: number) => {
    for (const [key, first] of ascending([...node.folders], ([name]) => name)) {
      // A folder that holds only one folder reads as one row: `services/tenant`.
      let name = key;
      let child = first;
      while (child.files.length === 0 && child.folders.size === 1) {
        const [[inner, deeper]] = [...child.folders] as [[string, Node]];
        name = `${name}/${inner}`;
        child = deeper;
      }
      out.push({ kind: 'folder', path: `${path}${name}`, name, depth });
      walk(child, `${path}${name}/`, depth + 1);
    }
    for (const file of ascending(node.files, (item) => item.name.split('/').at(-1) ?? item.name)) {
      out.push({ kind: 'file', file, name: file.name.split('/').at(-1) ?? file.name, depth });
    }
  };
  walk(root, '', 0);
  return out;
}

export enum FileSort {
  Tree = 'tree',
  Recent = 'recent',
}

/** The files in the order the Sort menu picked: tree order, or the newest comment first and then the rest in tree order. */
export function sortedFiles(pr: PullRequestDetail, sort: FileSort): PrFile[] {
  const tree = fileTree(pr.files)
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.file);
  if (sort === FileSort.Tree) return tree;
  const newest = new Map<string, string>();
  for (const thread of threadsOf(pr)) {
    const place = thread.root.file_path;
    if (place === null) continue;
    const time = threadTime(thread);
    if (time > (newest.get(place) ?? '')) newest.set(place, time);
  }
  const commented = tree
    .filter((file) => newest.has(file.name))
    .sort((a, b) => (newest.get(b.name) as string).localeCompare(newest.get(a.name) as string));
  return [...commented, ...tree.filter((file) => !newest.has(file.name))];
}
