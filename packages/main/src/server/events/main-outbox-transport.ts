import type { Prisma } from "@prisma/client";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

export const MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES = [
  "creative.retry.dispatch.v2",
  "creative.generation.dispatch.v2",
  "incident.retry.dispatch.v2",
  "generation.retry.dispatch.v2",
] as const;

export const MAIN_OUTBOX_TRANSPORT_QUEUES = [
  {
    queue: "chat",
    eventTypes: Object.values(MAIN_TO_CHAT_EVENTS),
  },
  {
    queue: "product_event",
    eventTypes: ["product.event.persisted.v2"],
  },
  {
    queue: "generation_terminal_record",
    eventTypes: ["generation.terminal_record.accepted.v1"],
  },
  {
    queue: "generation_dispatch",
    eventTypes: MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES,
  },
  {
    queue: "incident_correlation",
    eventTypes: ["generation.incident.correlate.v2"],
  },
] as const;

export const MAIN_OUTBOX_TRANSPORT_EVENT_TYPES = MAIN_OUTBOX_TRANSPORT_QUEUES
  .flatMap(({ eventTypes }) => [...eventTypes]);

// INVARIANT: recovery and dispatch must share one vocabulary. Pending and
// dispatched are the only deliverable states; every other listed state is an
// audited terminal disposition that must be preserved, not mistaken for an
// in-flight or corrupt carrier.
export const MAIN_OUTBOX_TRANSPORT_DELIVERABLE_STATUSES = [
  "pending",
  "dispatched",
] as const;

export const MAIN_OUTBOX_TRANSPORT_TERMINAL_STATUSES = [
  "delivered",
  "failed",
  "rejected",
  "cancelled",
  "discarded_target_missing",
] as const;

export const MAIN_OUTBOX_TRANSPORT_KNOWN_STATUSES = [
  ...MAIN_OUTBOX_TRANSPORT_DELIVERABLE_STATUSES,
  ...MAIN_OUTBOX_TRANSPORT_TERMINAL_STATUSES,
] as const;

export function pendingMainOutboxTransportWhere(): Prisma.MainOutboxEventWhereInput {
  return {
    eventType: { in: [...MAIN_OUTBOX_TRANSPORT_EVENT_TYPES] },
    status: { in: [...MAIN_OUTBOX_TRANSPORT_DELIVERABLE_STATUSES] },
  };
}
