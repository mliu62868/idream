import { randomUUID } from "node:crypto";

export function cryptoRandomId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
