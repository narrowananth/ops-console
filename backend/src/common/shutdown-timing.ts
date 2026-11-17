import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

type Hook = (...args: unknown[]) => unknown;

/**
 * Logs how long each provider's `onModuleDestroy` takes when the app closes, so a slow stop names its cause. Nest runs
 * the hooks of one module together and the modules one after another.
 */
export function timeShutdownHooks(app: INestApplication, log: (text: string) => void): void {
  const wrapped = new WeakSet<object>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of [...module.providers.values(), ...module.controllers.values()]) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null || wrapped.has(instance)) continue;
      const holder = instance as { onModuleDestroy?: unknown };
      if (typeof holder.onModuleDestroy !== 'function') continue;
      const hook = holder.onModuleDestroy as Hook;
      wrapped.add(instance);
      holder.onModuleDestroy = async (...args: unknown[]) => {
        const started = Date.now();
        try {
          return await hook.apply(instance, args);
        } finally {
          log(`${instance.constructor.name} stopped in ${Date.now() - started} ms`);
        }
      };
    }
  }
}
