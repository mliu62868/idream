// Support keeps its five documented queue priorities. Linked Cases use the
// same deadline instead of applying the separate content-review SLA policy.
const SUPPORT_SLA_HOURS = [4, 12, 24, 48, 72] as const;

export function supportSlaDueAt(priority: number, createdAt: Date) {
  const hours = SUPPORT_SLA_HOURS[priority - 1] ?? 24;
  return new Date(createdAt.getTime() + hours * 60 * 60 * 1_000);
}
