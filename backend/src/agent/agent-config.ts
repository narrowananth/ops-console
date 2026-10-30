import type { UsageSource } from '../accounts/usage-source';
import type { AgentSdk } from './agent-sdk';

export const AGENT_CONFIG = Symbol('AGENT_CONFIG');

export type AgentConfig = {
  sdk: AgentSdk;
  /** Where an account's current usage comes from, besides its runs. */
  usage: UsageSource;
};
