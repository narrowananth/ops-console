import type { z } from 'zod';

export type SettingDefinition<T = unknown> = { key: string; schema: z.ZodType<T>; default: T };

/** Each spec registers the keys it owns, with a schema and a default. */
export class SettingsRegistry {
  private readonly definitions = new Map<string, SettingDefinition>();

  register<T>(definition: SettingDefinition<T>): void {
    if (this.definitions.has(definition.key)) throw new Error(`setting ${definition.key} is registered twice`);
    this.definitions.set(definition.key, definition as SettingDefinition);
  }

  get(key: string): SettingDefinition | undefined {
    return this.definitions.get(key);
  }

  all(): SettingDefinition[] {
    return [...this.definitions.values()];
  }
}
