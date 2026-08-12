import { z } from "zod";
import {
  chatImageAcceptedPayloadSchema,
  chatImageCompletedPayloadSchema,
  chatImageFailedPayloadSchema,
  chatSessionReleaseMigrationRequestedPayloadSchema,
} from "./payloads";
import { durableEventEnvelopeSchema, type DurableEventEnvelope } from "./durable";
import { MAIN_TO_CHAT_EVENTS, mainToChatEventType } from "./events";

export const MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION =
  "DISCARD_MAIN_TO_CHAT_TARGET_MISSING" as const;

export const mainToChatTargetIdentitySchema = z.object({
  kind: z.enum(["attachment", "session"]),
  id: z.string().min(1),
}).strict();

export const mainToChatReceiverDispositionSchema = z.enum([
  "exact_receipt",
  "target_present",
  "expected_target_missing",
  "no_target_required",
  "receiver_hash_conflict",
  "receiver_quarantined",
  "discarded_target_missing",
  "invalid_event_payload",
]);

export const mainToChatReceiverAuthoritySchema = z.object({
  sourceEventId: z.string().min(1),
  envelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  disposition: mainToChatReceiverDispositionSchema,
  target: mainToChatTargetIdentitySchema.nullable(),
  targetStatus: z.string().min(1).nullable(),
  receipt: z.object({
    receiptId: z.string().min(1),
    payloadHash: z.string().min(1),
    eventType: z.string().min(1),
    status: z.string().min(1),
  }).strict().nullable(),
}).strict();

export const mainToChatReceiverAuthorityRequestSchema = z.object({
  events: z.array(durableEventEnvelopeSchema).min(1).max(50),
}).strict();

export const mainToChatReceiverAuthorityResponseSchema = z.object({
  results: z.array(mainToChatReceiverAuthoritySchema).max(50),
}).strict();

export const mainToChatTargetMissingDispositionRequestSchema = z.object({
  events: z.array(z.object({
    envelope: durableEventEnvelopeSchema,
    expectedEnvelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedTarget: mainToChatTargetIdentitySchema,
  }).strict()).min(1).max(50),
  confirmation: z.literal(MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION),
}).strict();

export const mainToChatTargetMissingDispositionOutcomeSchema = z.enum([
  "discarded_target_missing",
  "already_discarded_target_missing",
  "expected_target_present",
  "receipt_conflict",
  "invalid_envelope_hash",
  "invalid_event_payload",
  "expected_target_mismatch",
  "event_has_no_target",
]);

export const mainToChatTargetMissingDispositionResponseSchema = z.object({
  results: z.array(z.object({
    sourceEventId: z.string().min(1),
    outcome: mainToChatTargetMissingDispositionOutcomeSchema,
    envelopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    target: mainToChatTargetIdentitySchema.nullable(),
    targetStatus: z.string().min(1).nullable(),
    receiptId: z.string().min(1).nullable(),
  }).strict()).max(50),
}).strict();

export type MainToChatTargetIdentity = z.infer<typeof mainToChatTargetIdentitySchema>;
export type MainToChatReceiverAuthority = z.infer<typeof mainToChatReceiverAuthoritySchema>;
export type MainToChatTargetMissingDispositionRequest = z.infer<
  typeof mainToChatTargetMissingDispositionRequestSchema
>;
export type MainToChatTargetMissingDispositionResponse = z.infer<
  typeof mainToChatTargetMissingDispositionResponseSchema
>;

export type MainToChatTargetResolution =
  | { readonly valid: true; readonly target: MainToChatTargetIdentity | null }
  | { readonly valid: false; readonly target: null };

/**
 * INVARIANT: both sides derive the receiver target from the exact event-specific
 * payload contract. A caller-supplied target is evidence to compare, never
 * authority that can redirect a terminal disposition.
 */
export function resolveMainToChatTarget(
  envelope: DurableEventEnvelope,
): MainToChatTargetResolution {
  if (!mainToChatEventType.safeParse(envelope.eventType).success) {
    return { valid: false, target: null };
  }
  switch (envelope.eventType) {
    case MAIN_TO_CHAT_EVENTS.chatImageAccepted: {
      const payload = chatImageAcceptedPayloadSchema.safeParse(envelope.payload);
      return payload.success
        ? { valid: true, target: { kind: "attachment", id: payload.data.attachmentId } }
        : { valid: false, target: null };
    }
    case MAIN_TO_CHAT_EVENTS.chatImageCompleted: {
      const payload = chatImageCompletedPayloadSchema.safeParse(envelope.payload);
      return payload.success
        ? { valid: true, target: { kind: "attachment", id: payload.data.attachmentId } }
        : { valid: false, target: null };
    }
    case MAIN_TO_CHAT_EVENTS.chatImageFailed: {
      const payload = chatImageFailedPayloadSchema.safeParse(envelope.payload);
      return payload.success
        ? { valid: true, target: { kind: "attachment", id: payload.data.attachmentId } }
        : { valid: false, target: null };
    }
    case MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested: {
      const payload = chatSessionReleaseMigrationRequestedPayloadSchema.safeParse(
        envelope.payload,
      );
      return payload.success
        ? { valid: true, target: { kind: "session", id: payload.data.sessionId } }
        : { valid: false, target: null };
    }
    default:
      return { valid: true, target: null };
  }
}
