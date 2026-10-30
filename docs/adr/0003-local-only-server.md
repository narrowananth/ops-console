# Local-only server

The backend listens on `127.0.0.1` only and every request and WebSocket carries a session token
issued at startup. The terminal is a real shell on the operator's machine, and the agent holds
connections to production data, so reaching the server is the same as reaching the machine. Sharing
the console with a team means a separate deployment with real sign-in, not opening this port.

## Consequences

No tunnel, no `0.0.0.0`, no CORS beyond the frontend's own origin. A review flags any change that
widens this.
