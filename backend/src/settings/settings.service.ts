import { Inject, Injectable } from '@nestjs/common';
import type { Settings } from '@ops-console/shared';
import { validationFailed } from '../common/errors';
import { nowIso, settings } from '../db/schema';
import { STORE, type Store } from '../db/store';
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
      for (const value of values) {
        tx.insert(settings)
          .values(value)
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: value.value, updatedAt: nowIso },
          })
          .run();
      }
      emit('settings.updated', { keys: values.map((value) => value.key) });
    });
    return this.read();
  }
}
