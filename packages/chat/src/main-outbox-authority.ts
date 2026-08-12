import {
  durableEnvelopeHash,
  mainToChatReceiverAuthorityRequestSchema,
  mainToChatReceiverAuthorityResponseSchema,
  mainToChatTargetMissingDispositionRequestSchema,
  mainToChatTargetMissingDispositionResponseSchema,
  resolveMainToChatTarget,
  type DurableEventEnvelope,
  type MainToChatReceiverAuthority,
  type MainToChatTargetIdentity,
} from "@idream/shared/contracts";
import { Prisma } from "../generated/client/client.js";
import { chatPrisma, type ChatPrismaClient } from "./db.js";
import { receiptId } from "./inbox.js";

type Db = ChatPrismaClient | Prisma.TransactionClient;

export async function inspectMainToChatReceiverAuthority(
  raw: unknown,
  prisma: Db = chatPrisma,
) {
  const request = mainToChatReceiverAuthorityRequestSchema.parse(raw);
  const results: MainToChatReceiverAuthority[] = [];
  // One pg client backs an interactive transaction. Keep receiver reads
  // serialized so this helper is safe with either the root or tx client.
  for (const event of request.events) {
    results.push(await inspectOne(event, prisma));
  }
  return mainToChatReceiverAuthorityResponseSchema.parse({ results });
}

export async function discardMainToChatTargetMissing(
  raw: unknown,
  prisma: ChatPrismaClient = chatPrisma,
) {
  const request = mainToChatTargetMissingDispositionRequestSchema.parse(raw);
  const results = [];
  for (const item of request.events) {
    let completed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        results.push(await prisma.$transaction(
          (tx) => discardOne(item, tx),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ));
        completed = true;
        break;
      } catch (error) {
        if (attempt < 2 && isRetryableConflict(error)) continue;
        throw error;
      }
    }
    if (!completed) throw new Error("target-missing disposition could not be serialized");
  }
  return mainToChatTargetMissingDispositionResponseSchema.parse({ results });
}

async function inspectOne(
  event: DurableEventEnvelope,
  prisma: Db,
): Promise<MainToChatReceiverAuthority> {
  const envelopeHash = durableEnvelopeHash(event);
  const targetResolution = event.sourceService === "main"
    ? resolveMainToChatTarget(event)
    : { valid: false as const, target: null };
  if (!targetResolution.valid) {
    return authorityResult(event, envelopeHash, "invalid_event_payload", null, null, null);
  }

  const receipt = await prisma.chatInboxEvent.findUnique({
    where: {
      sourceService_sourceEventId: {
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
      },
    },
    select: {
      id: true,
      payloadHash: true,
      eventType: true,
      status: true,
    },
  });
  const receiptEvidence = receipt
    ? {
        receiptId: receipt.id,
        payloadHash: receipt.payloadHash,
        eventType: receipt.eventType,
        status: receipt.status,
      }
    : null;
  if (receipt) {
    if (receipt.status === "quarantined") {
      return authorityResult(
        event,
        envelopeHash,
        "receiver_quarantined",
        targetResolution.target,
        null,
        receiptEvidence,
      );
    }
    if (receipt.payloadHash !== envelopeHash || receipt.eventType !== event.eventType) {
      return authorityResult(
        event,
        envelopeHash,
        "receiver_hash_conflict",
        targetResolution.target,
        null,
        receiptEvidence,
      );
    }
    return authorityResult(
      event,
      envelopeHash,
      receipt.status === "discarded_target_missing"
        ? "discarded_target_missing"
        : "exact_receipt",
      targetResolution.target,
      null,
      receiptEvidence,
    );
  }

  if (!targetResolution.target) {
    return authorityResult(event, envelopeHash, "no_target_required", null, null, null);
  }
  const targetStatus = await receiverTargetStatus(targetResolution.target, prisma);
  return authorityResult(
    event,
    envelopeHash,
    targetStatus === null ? "expected_target_missing" : "target_present",
    targetResolution.target,
    targetStatus,
    null,
  );
}

async function discardOne(
  item: {
    readonly envelope: DurableEventEnvelope;
    readonly expectedEnvelopeHash: string;
    readonly expectedTarget: MainToChatTargetIdentity;
  },
  tx: Prisma.TransactionClient,
) {
  const envelopeHash = durableEnvelopeHash(item.envelope);
  const targetResolution = item.envelope.sourceService === "main"
    ? resolveMainToChatTarget(item.envelope)
    : { valid: false as const, target: null };
  if (envelopeHash !== item.expectedEnvelopeHash) {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "invalid_envelope_hash",
      targetResolution.target,
      null,
      null,
    );
  }
  if (!targetResolution.valid) {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "invalid_event_payload",
      null,
      null,
      null,
    );
  }
  if (!targetResolution.target) {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "event_has_no_target",
      null,
      null,
      null,
    );
  }
  if (!sameTarget(targetResolution.target, item.expectedTarget)) {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "expected_target_mismatch",
      targetResolution.target,
      null,
      null,
    );
  }

  const authority = await inspectOne(item.envelope, tx);
  if (authority.disposition === "discarded_target_missing") {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "already_discarded_target_missing",
      authority.target,
      authority.targetStatus,
      authority.receipt?.receiptId ?? null,
    );
  }
  if (authority.disposition === "target_present") {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "expected_target_present",
      authority.target,
      authority.targetStatus,
      null,
    );
  }
  if (authority.disposition !== "expected_target_missing") {
    return dispositionResult(
      item.envelope,
      envelopeHash,
      "receipt_conflict",
      authority.target,
      authority.targetStatus,
      authority.receipt?.receiptId ?? null,
    );
  }

  const id = receiptId(item.envelope.sourceService, item.envelope.sourceEventId);
  await tx.chatInboxEvent.create({
    data: {
      id,
      sourceService: item.envelope.sourceService,
      sourceEventId: item.envelope.sourceEventId,
      payloadHash: envelopeHash,
      eventType: item.envelope.eventType,
      payload: item.envelope.payload as never,
      status: "discarded_target_missing",
      processedAt: new Date(),
    },
  });
  return dispositionResult(
    item.envelope,
    envelopeHash,
    "discarded_target_missing",
    authority.target,
    null,
    id,
  );
}

async function receiverTargetStatus(
  target: MainToChatTargetIdentity,
  prisma: Db,
): Promise<string | null> {
  if (target.kind === "attachment") {
    return (await prisma.messageAttachment.findUnique({
      where: { id: target.id },
      select: { status: true },
    }))?.status ?? null;
  }
  return (await prisma.chatSession.findUnique({
    where: { id: target.id },
    select: { status: true },
  }))?.status ?? null;
}

function authorityResult(
  event: DurableEventEnvelope,
  envelopeHash: string,
  disposition: MainToChatReceiverAuthority["disposition"],
  target: MainToChatTargetIdentity | null,
  targetStatus: string | null,
  receipt: MainToChatReceiverAuthority["receipt"],
): MainToChatReceiverAuthority {
  return {
    sourceEventId: event.sourceEventId,
    envelopeHash,
    disposition,
    target,
    targetStatus,
    receipt,
  };
}

function dispositionResult(
  event: DurableEventEnvelope,
  envelopeHash: string,
  outcome:
    | "discarded_target_missing"
    | "already_discarded_target_missing"
    | "expected_target_present"
    | "receipt_conflict"
    | "invalid_envelope_hash"
    | "invalid_event_payload"
    | "expected_target_mismatch"
    | "event_has_no_target",
  target: MainToChatTargetIdentity | null,
  targetStatus: string | null,
  receiptIdValue: string | null,
) {
  return {
    sourceEventId: event.sourceEventId,
    outcome,
    envelopeHash,
    target,
    targetStatus,
    receiptId: receiptIdValue,
  };
}

function sameTarget(left: MainToChatTargetIdentity, right: MainToChatTargetIdentity) {
  return left.kind === right.kind && left.id === right.id;
}

function isRetryableConflict(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "P2002" || error.code === "P2034"),
  );
}
