export type ToolCall = { toolName: string; input: Record<string, unknown>; workingDir: string };

/** What a PROD write needs the operator to see before approving it. */
export type ProdWrite = { summary: string };

export type ProdWriteMatcher = (call: ToolCall) => ProdWrite | null;

/**
 * The PROD-write rule the `PreToolUse` hook checks every tool call against. `05-settings-dev-tools` supplies it;
 * until then it matches nothing.
 */
export class ProdWriteRule {
  private matcher: ProdWriteMatcher = () => null;

  use(matcher: ProdWriteMatcher): void {
    this.matcher = matcher;
  }

  match(call: ToolCall): ProdWrite | null {
    return this.matcher(call);
  }
}
