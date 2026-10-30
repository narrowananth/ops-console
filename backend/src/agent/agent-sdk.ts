import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export const AGENT_SDK = Symbol('AGENT_SDK');

/** The one call the console makes into the Claude Agent SDK for a run. Tests replace it with a scripted fake. */
export interface AgentSdk {
  query(prompt: string, options: Options): AsyncIterable<SDKMessage>;
}

export class ClaudeAgentSdk implements AgentSdk {
  query(prompt: string, options: Options): AsyncIterable<SDKMessage> {
    return query({ prompt, options });
  }
}
