const KEY = 'ops-console.token';

/**
 * `ops-console open` passes the token in the URL fragment, which never reaches the server. Move it into local
 * storage, so closing the tab and opening the console again stays signed in, and out of the address bar.
 */
export function takeTokenFromUrl(): void {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (!token) return;
  localStorage.setItem(KEY, token);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function sessionToken(): string | null {
  const kept = localStorage.getItem(KEY);
  if (kept !== null) return kept;
  // A tab signed in by an older build holds it in session storage; keep it from now on.
  const tab = sessionStorage.getItem(KEY);
  if (tab !== null) localStorage.setItem(KEY, tab);
  return tab;
}

/** The daemon turned the token down, after a reinstall made a new one: sign in again with `ops-console open`. */
export function forgetToken(): void {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
}
