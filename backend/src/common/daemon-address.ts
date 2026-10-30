export const DAEMON_ADDRESS = Symbol('DAEMON_ADDRESS');

/** Where this daemon listens; the port is known once it is listening. */
export class DaemonAddress {
  port = 0;

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}
