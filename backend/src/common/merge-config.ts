/** Blank strings keep the stored value; objects merge field by field. */
export function mergeConfig(
  stored: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...stored };
  for (const [key, value] of Object.entries(changes)) {
    if (value === '') continue;
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? mergeConfig(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}
