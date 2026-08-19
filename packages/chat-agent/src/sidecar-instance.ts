import { randomUUID } from "node:crypto";
import type { CompanionReadiness } from "@idream/shared/chat/companion-runtime";

/** One opaque process identity exposes replacements without persisting host or PID data. */
export function createSidecarInstanceIdentity(
  id: () => string = randomUUID,
  now: () => Date = () => new Date(),
): CompanionReadiness["instance"] {
  return {
    id: id(),
    startedAt: now().toISOString(),
  };
}
