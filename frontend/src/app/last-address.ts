import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { z } from 'zod';
import { readStored, writeStored } from '../lib/remember';

const PAGE_PATHS = [
  '/monitor',
  '/workspace',
  '/devtools',
  '/integrations',
  '/connections',
  '/repos',
  '/setup',
  '/agents',
  '/playbooks',
  '/skills',
];
const FIRST_PAGE = '/monitor';

const pageOf = (pathname: string) => PAGE_PATHS.find((path) => pathname === path || pathname.startsWith(`${path}/`));

/** Where a page was when the operator last left it, picks in the address included. */
export function lastAddress(path: string): string {
  return readStored(`nav.last.${path}`, z.string().startsWith(path), path);
}

/** The page the console was last on; the first time, the Monitor. */
export function lastPage(): string {
  return lastAddress(readStored('nav.page', z.enum(PAGE_PATHS as [string, ...string[]]), FIRST_PAGE));
}

/** Keeps each page's address as the operator moves, so the sidebar and `/` bring them back to it. */
export function useKeepAddress(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const page = pageOf(pathname);
    if (!page) return;
    writeStored('nav.page', page, FIRST_PAGE);
    writeStored(`nav.last.${page}`, pathname + search, page);
  }, [pathname, search]);
}
