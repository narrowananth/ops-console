/**
 * The SDK warns on every run that `canUseTool` is not consulted in `bypassPermissions` mode. The console passes it
 * anyway: the callback carries the agent's questions to the operator, and a run's Access mode can change between
 * runs. The warning fills the daemon log with one line per run, so it is left out. Every other warning still shows.
 */
export function quietShadowedPrompt(proc: NodeJS.Process = process): void {
  const emit = proc.emitWarning.bind(proc) as (...args: unknown[]) => void;
  proc.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const options = rest[0] as { code?: string } | string | undefined;
    const code = typeof options === 'object' && options !== null ? options.code : rest[1];
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
    emit(warning, ...rest);
  }) as typeof proc.emitWarning;
}
