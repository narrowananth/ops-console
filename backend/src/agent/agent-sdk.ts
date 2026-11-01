import {
  type Options,
  query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export const AGENT_SDK = Symbol('AGENT_SDK');

/** The calls the console makes into the Claude Agent SDK. Tests replace them with a scripted fake. */
export interface AgentSdk {
  query(prompt: string, options: Options): AsyncIterable<SDKMessage>;
  /**
   * Puts the files the conversation in `options.resume` changed with its edit tools back as they were when
   * `userMessageId` was sent. Runs no turn.
   */
  rewindFiles(userMessageId: string, options: Options): Promise<RewindFilesResult>;
}

export class ClaudeAgentSdk implements AgentSdk {
  query(prompt: string, options: Options): AsyncIterable<SDKMessage> {
    return query({ prompt, options });
  }

  async rewindFiles(userMessageId: string, options: Options): Promise<RewindFilesResult> {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Input that sends nothing: Claude Code loads the conversation for the control request and starts no turn.
    const nothing: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => held.then(() => ({ done: true, value: undefined })) }),
    };
    const running = query({ prompt: nothing, options });
    try {
      // Only a dry run lists the files; the real one then puts them back.
      const preview = await running.rewindFiles(userMessageId, { dryRun: true });
      if (!preview.canRewind) return preview;
      return { ...preview, ...(await running.rewindFiles(userMessageId)) };
    } finally {
      release();
      running.close();
    }
  }
}
