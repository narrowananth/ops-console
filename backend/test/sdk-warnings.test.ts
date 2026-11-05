import { describe, expect, it, vi } from 'vitest';
import { quietShadowedPrompt } from '../src/agent/sdk-warnings';

describe('quietShadowedPrompt', () => {
  it('drops the SDK warning that canUseTool is not consulted, and lets every other warning through', () => {
    const emitted: unknown[] = [];
    const proc = { emitWarning: vi.fn((warning: unknown) => emitted.push(warning)) } as unknown as NodeJS.Process;
    const original = proc.emitWarning;
    quietShadowedPrompt(proc);

    proc.emitWarning('canUseTool will not be invoked', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
    proc.emitWarning('something else', { code: 'OTHER' });
    proc.emitWarning('plain');

    expect(emitted).toEqual(['something else', 'plain']);
    expect(original).toHaveBeenCalledTimes(2);
  });
});
