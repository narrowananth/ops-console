import { Inject, Injectable } from '@nestjs/common';
import type { Settings } from '@ops-console/shared';
import type { z } from 'zod';
import { validationFailed } from '../common/errors';
import { nowIso, settings } from '../db/schema';
import { STORE, type Store, type Tx } from '../db/store';
import { SettingsRegistry } from './settings.registry';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SettingsRegistry) private readonly registry: SettingsRegistry,
  ) {}

  read(): Settings {
    const stored = new Map(
      this.store.db
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.value]),
    );
    const result: Settings = {};
    for (const definition of this.registry.all()) {
      const value = stored.get(definition.key);
      result[definition.key] = value === undefined ? definition.default : definition.schema.parse(JSON.parse(value));
    }
    return result;
  }

  /** Validates every key before writing any, so a bad key leaves all values unchanged. */
  update(patch: Record<string, unknown>): Settings {
    const values: { key: string; value: string }[] = [];
    for (const [key, raw] of Object.entries(patch)) {
      const definition = this.registry.get(key);
      if (!definition) throw validationFailed(`unknown setting: ${key}`);
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) throw validationFailed(`invalid value for setting: ${key}`);
      values.push({ key, value: JSON.stringify(parsed.data) });
    }
    this.store.write((tx, emit) => {
      for (const { key, value } of values) writeSetting(tx, key, value);
      emit('settings.updated', { keys: values.map((value) => value.key) });
    });
    for (const { key } of values) this.registry.get(key)?.onChange?.();
    return this.read();
  }

  /** One key's value, stored or default, typed by the schema its owner registered. */
  get<T>(key: string, schema: z.ZodType<T>): T {
    return schema.parse(this.read()[key]);
  }

  /** Writes one key inside a caller's transaction; the caller emits `settings.updated`. */
  set(tx: Tx, key: string, value: unknown): void {
    const definition = this.registry.get(key);
    if (!definition) throw new Error(`setting ${key} is not registered`);
    writeSetting(tx, key, JSON.stringify(definition.schema.parse(value)));
  }
}

function writeSetting(tx: Tx, key: string, value: string): void {
  tx.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } })
    .run();
}
