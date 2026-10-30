import type { AgentSdk } from './agent-sdk';

export const AGENT_CONFIG = Symbol('AGENT_CONFIG');

export type AgentConfig = {
  sdk: AgentSdk;
  /** The operator's own Claude Code config dir: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  claudeHome: string;
};
