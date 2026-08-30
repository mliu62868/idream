/** Canonical JSON for digests: sorted object keys, no host-specific ordering. */
export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))) {
      if (child !== undefined) output[key] = stableValue(child);
    }
    return output;
  }
  throw new Error(`canonical JSON contains unsupported ${typeof value}`);
}
