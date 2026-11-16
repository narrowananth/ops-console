/** Whether a link points at a page on this Mac: `localhost`, `127.0.0.1`, `[::1]` or a `*.localhost` name over http(s). */
export function isLoopbackUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host.endsWith('.localhost');
}

/** An `http` or `https` address, as a link can carry; anything else (`javascript:`, `file:`) is not a link. */
export function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
