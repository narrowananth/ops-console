import type { WsEvent, WsEventData, WsEventName } from '@ops-console/shared';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import type { WsHub } from '../common/ws-hub';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Emit = <E extends WsEventName>(event: E, data: WsEventData<E>) => void;

export const STORE = Symbol('STORE');

export class Store {
  readonly db: Db;

  constructor(
    sqlite: Database.Database,
    private readonly hub: WsHub,
  ) {
    this.db = drizzle({ client: sqlite, schema });
  }

  /**
   * Runs a state change in one transaction. Events passed to `emit` go out only after the commit;
   * a change that throws rolls back and sends none.
   */
  write<T>(change: (tx: Tx, emit: Emit) => T): T {
    const events: WsEvent[] = [];
    const emit: Emit = (event, data) => {
      events.push({ event, at: new Date().toISOString(), data } as WsEvent);
    };
    const result = this.db.transaction((tx) => change(tx, emit));
    for (const event of events) this.hub.publish(event);
    return result;
  }
}
