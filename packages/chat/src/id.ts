import { randomUUID } from "node:crypto";

// App-generated ids for chat.* rows (no DB default; cross-schema FK-free).
// Prefix keeps ids self-describing in logs and durable ledgers.
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
