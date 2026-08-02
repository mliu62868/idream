// SPEC: primitives shared by the ourdream workspaces, kept in one module so the
// same three lines stop being retyped in every 1000-line client component.

/** `1 item` / `3 items` — pluralisation for inline counts. */
export function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Narrows parsed JSON to a plain object. Arrays are rejected on purpose: every
 * caller reads named fields off the value, and `[]` would otherwise pass the
 * `typeof === "object"` check and yield `undefined` for all of them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
