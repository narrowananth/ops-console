import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * The subagents every run can hand work to with the Agent tool, besides the SDK's own. Each takes the part of a run
 * that reads or prints a lot, so the main agent's context keeps the answer and not the output. They run under the
 * run's own sandbox, permission rules and hooks: a subagent gets no reach the main agent does not have.
 */
export const CONSOLE_SUBAGENTS: Record<string, AgentDefinition> = {
  explorer: {
    description:
      'Finds and reads code. Use it for a search that spans more than a few files: where something is defined or used, how a folder is laid out, what several files say about one question. Read only.',
    prompt:
      'You search and read code to answer one question. Use Grep, Glob and Read. Change nothing and run no command. Answer with the file paths and line numbers that matter, each with one line on what it shows, then a short conclusion. Quote no more code than the answer needs.',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'haiku',
  },
  'test-runner': {
    description:
      'Runs tests, a type check, a linter or a build and reports what failed. Use it for any command that prints more than a screen of output.',
    prompt:
      'You run the command you are given and report the result. Say whether it passed. For each failure give the test or file, the line, and the first error message in full. Leave out passing output, banners and repeated stack frames. Change no file. If the command cannot run, say why and stop.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    model: 'haiku',
  },
  reviewer: {
    description:
      'Reviews a diff or a set of files for bugs, missed cases and breaks of the surrounding code. Use it after a change, before reporting it done. Read only.',
    prompt:
      'You review the change you are pointed at. Read the changed files and the code around them. Report each real problem with its file and line, what goes wrong and the input that triggers it. Skip style and taste. Say "no findings" when there are none. Change no file.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
};
