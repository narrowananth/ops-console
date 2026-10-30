const KEY = 'ops-console.token';

/**
 * `ops-console open` passes the token in the URL fragment, which never reaches the server. Move it into
 * this tab's session storage and out of the address bar.
 */
export function takeTokenFromUrl(): void {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (!token) return;
  sessionStorage.setItem(KEY, token);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function sessionToken(): string | null {
  return sessionStorage.getItem(KEY);
}
