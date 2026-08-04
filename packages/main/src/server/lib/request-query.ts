export function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
