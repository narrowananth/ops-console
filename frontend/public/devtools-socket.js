// Runs ahead of DevTools' own scripts in the Inspector window. DevTools opens its WebSocket with no subprotocols, and the
// daemon takes the session token only as one, so this adds it. The token stays out of the address.
// The protocol name is WS_PROTOCOL in shared/src/ws.ts and the key is KEY in frontend/src/lib/session.ts.
(() => {
  const PROTOCOL = 'ops-console';
  const KEY = 'ops-console.token';
  const INSPECTOR = /^\/browser\/[^/]+\/devtools$/;
  const Plain = window.WebSocket;
  window.WebSocket = class extends Plain {
    constructor(url, protocols) {
      const target = new URL(url, window.location.href);
      const token = localStorage.getItem(KEY);
      const ours = target.host === window.location.host && INSPECTOR.test(target.pathname) && token !== null;
      super(url, ours ? [PROTOCOL, token] : protocols);
    }
  };
})();
