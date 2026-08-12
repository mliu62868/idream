import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "./lib/db";
import { canonicalJsonHash } from "./modules/admin-v2/shared/idempotency";
import type { AgeVerificationProbeEvidence, ProbeReportOf } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  verificationId: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
type AgeProbeReport = ProbeReportOf<AgeVerificationProbeEvidence>;

type AgeVerificationSnapshot = {
  id: string;
  userId: string;
  provider: string;
  providerVerificationId: string | null;
  status: string;
  jurisdiction: string | null;
  verifiedAt: Date | null;
  metadata: unknown;
};

type AgeProviderEventSnapshot = {
  id: string;
  providerEventId: string;
  type: string | null;
  payload: unknown;
  targetHash: string | null;
  processedAt: Date | null;
  deliveries: Array<{
    deliveryId: string;
    payload: unknown;
    payloadHash: string;
  }>;
};

export type AgeAuthorityReader = {
  findVerification(verificationId: string): Promise<AgeVerificationSnapshot | null>;
  countVerificationEffects(input: {
    provider: string;
    providerVerificationId: string;
  }): Promise<number>;
  findProviderEvents(input: {
    provider: string;
    targetHash: string;
  }): Promise<AgeProviderEventSnapshot[]>;
};

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("ageVerificationProbe"),
    verificationId:
      probeCliArg("age-verification-id") ??
      process.env.AGE_VERIFICATION_PROBE_VERIFICATION_ID ??
      null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    provider: process.env.AGE_VERIFICATION_PROVIDER ?? "mock",
    serviceUrl: process.env.AGE_VERIFY_SERVICE_URL ?? null,
    callbackUrl: process.env.AGE_VERIFY_CALLBACK_URL ?? null,
    linkBackUrl: process.env.AGE_VERIFY_LINK_BACK_URL ?? null,
    verificationId: options.verificationId,
  });

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

// SPEC: production age readiness audits a real local verification intent after Go.cam
// called the signed webhook. It never creates a session for a synthetic/nonexistent user.
export async function runProbe(input: {
  provider: string;
  serviceUrl: string | null;
  callbackUrl: string | null;
  linkBackUrl: string | null;
  verificationId: string | null;
  authorityReader?: AgeAuthorityReader;
  now?: () => Date;
}): Promise<AgeProbeReport> {
  const now = input.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    serviceUrl: input.serviceUrl,
    jurisdiction: null,
    providerVerificationId: null,
    status: null,
    url: null,
    terminal: null,
  } satisfies Omit<AgeProbeReport, "ok" | "durationMs" | "error">;

  if (input.provider !== "gocam") {
    return failedReport(baseReport, startedAt, {
      code: "unsupported_age_verification_provider",
      message: `Age terminal probe requires gocam, received ${input.provider}`,
      retryable: false,
    });
  }
  if (!input.verificationId?.trim()) {
    return failedReport(baseReport, startedAt, {
      code: "age_probe_verification_id_required",
      message:
        "--age-verification-id (or AGE_VERIFICATION_PROBE_VERIFICATION_ID) must identify a verification created through the real signed-in product flow",
      retryable: false,
    });
  }

  try {
    const reader = input.authorityReader ?? prismaAgeAuthorityReader;
    const verification = await reader.findVerification(input.verificationId);
    if (!verification) {
      return failedReport(baseReport, startedAt, {
        code: "age_probe_verification_not_found",
        message: `AgeVerification ${input.verificationId} was not found in Main`,
        retryable: false,
      });
    }
    const metadata = asRecord(verification.metadata);
    const verificationReport = {
      ...baseReport,
      jurisdiction: verification.jurisdiction,
      providerVerificationId: verification.providerVerificationId,
      status: verification.status,
      url: stringField(metadata, "sessionUrl") ?? null,
    };
    const authority = await inspectAgeTerminalAuthority({
      reader,
      verification,
      callbackUrl: input.callbackUrl,
      linkBackUrl: input.linkBackUrl,
    });
    if (!authority.ok) {
      return failedReport(verificationReport, startedAt, {
        code: "age_terminal_authority_invalid",
        message: authority.problems.join("; "),
        retryable: false,
      });
    }
    return {
      ...verificationReport,
      ok: true,
      durationMs: Date.now() - startedAt,
      terminal: authority.terminal,
      error: null,
    };
  } catch (error) {
    return failedReport(baseReport, startedAt, {
      code: "age_verification_probe_failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
}

export async function inspectAgeTerminalAuthority(input: {
  reader: AgeAuthorityReader;
  verification: AgeVerificationSnapshot;
  callbackUrl: string | null;
  linkBackUrl: string | null;
}): Promise<
  | { ok: true; terminal: NonNullable<AgeProbeReport["terminal"]> }
  | { ok: false; problems: string[] }
> {
  const { reader, verification } = input;
  const problems: string[] = [];
  const metadata = asRecord(verification.metadata);
  const callbackUrl = stringField(metadata, "callbackUrl") ?? null;
  const linkBackUrl = stringField(metadata, "linkBackUrl") ?? null;
  const sessionUrl = stringField(metadata, "sessionUrl") ?? null;

  if (verification.provider !== "gocam") problems.push("verification provider is not gocam");
  if (!verification.providerVerificationId) {
    problems.push("verification has no provider identity");
  }
  if (verification.status !== "verified" || !verification.verifiedAt) {
    problems.push("verification is not terminally verified");
  }
  if (!sameUrl(callbackUrl, input.callbackUrl)) {
    problems.push("verification callback URL snapshot does not match configuration");
  }
  if (!sameUrl(linkBackUrl, input.linkBackUrl)) {
    problems.push("verification link-back URL snapshot does not match configuration");
  }
  if (!isPublicHttpsUrl(sessionUrl)) {
    problems.push("verification has no public HTTPS provider session URL");
  }
  if (!verification.providerVerificationId) {
    return { ok: false, problems };
  }

  const target = {
    providerVerificationId: verification.providerVerificationId,
    status: "verified",
    userId: verification.userId,
  };
  const targetHash = canonicalJsonHash(target);
  const [effectCount, events] = await Promise.all([
    reader.countVerificationEffects({
      provider: verification.provider,
      providerVerificationId: verification.providerVerificationId,
    }),
    reader.findProviderEvents({
      provider: verification.provider,
      targetHash,
    }),
  ]);
  if (effectCount !== 1) {
    problems.push("callback must terminalize exactly one age verification effect");
  }
  if (events.length !== 1) {
    problems.push("verified callback must map to exactly one provider event");
  }
  const event = events[0];
  if (
    !event ||
    event.type !== "age.verification" ||
    event.targetHash !== targetHash ||
    !event.processedAt ||
    !agePayloadMatches(event.payload, target)
  ) {
    problems.push("processed age callback event identity or payload is invalid");
  }

  const deliveries = event?.deliveries ?? [];
  const eventPayloadHash = event ? ageReplayPayloadHash(event.payload) : null;
  if (
    deliveries.length < 2 ||
    new Set(deliveries.map((delivery) => delivery.deliveryId)).size !== deliveries.length ||
    deliveries.some(
      (delivery) =>
        canonicalJsonHash(delivery.payload) !== delivery.payloadHash ||
        ageReplayPayloadHash(delivery.payload) !== eventPayloadHash ||
        !agePayloadMatches(delivery.payload, target),
    )
  ) {
    problems.push(
      "age callback replay does not contain two independently identified exact business-payload deliveries",
    );
  }

  if (problems.length > 0 || !event || !verification.verifiedAt) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    terminal: {
      authorityVersion: "age_verified_callback_v1",
      verificationId: verification.id,
      verificationStatus: verification.status,
      verifiedAt: verification.verifiedAt.toISOString(),
      callbackUrl,
      linkBackUrl,
      providerEventId: event.providerEventId,
      providerEventType: event.type,
      providerEventProcessedAt: event.processedAt!.toISOString(),
      providerEventTargetHash: targetHash,
      providerDeliveryCount: deliveries.length,
      providerDeliveryIds: deliveries.map((delivery) => delivery.deliveryId),
      providerDeliveryPayloadHashes: deliveries.map((delivery) => delivery.payloadHash),
      providerPayloadHash: eventPayloadHash,
      verificationEffectCount: effectCount,
      replayVerified: true,
    },
  };
}

const prismaAgeAuthorityReader: AgeAuthorityReader = {
  findVerification: (verificationId) =>
    prisma.ageVerification.findUnique({
      where: { id: verificationId },
      select: {
        id: true,
        userId: true,
        provider: true,
        providerVerificationId: true,
        status: true,
        jurisdiction: true,
        verifiedAt: true,
        metadata: true,
      },
    }),
  countVerificationEffects: (input) =>
    prisma.ageVerification.count({
      where: {
        provider: input.provider,
        providerVerificationId: input.providerVerificationId,
        status: "verified",
      },
    }),
  findProviderEvents: (input) =>
    prisma.providerEvent.findMany({
      where: {
        provider: input.provider,
        type: "age.verification",
        targetHash: input.targetHash,
      },
      include: {
        deliveries: {
          select: {
            deliveryId: true,
            payload: true,
            payloadHash: true,
          },
          orderBy: { receivedAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
};

function agePayloadMatches(
  value: unknown,
  target: { providerVerificationId: string; status: string; userId: string },
) {
  const payload = asRecord(value);
  const providerVerificationId =
    stringField(payload, "providerVerificationId") ??
    stringField(payload, "verificationId") ??
    stringField(payload, "sessionId");
  const userId = stringField(payload, "userId") ?? stringField(payload, "userData");
  return (
    providerVerificationId === target.providerVerificationId &&
    userId === target.userId &&
    normalizedAgeStatus(payload) === target.status
  );
}

function normalizedAgeStatus(payload: Record<string, unknown>) {
  const direct = stringField(payload, "status") ?? stringField(payload, "state");
  if (direct) {
    const value = direct.toLowerCase().replaceAll("_", "-");
    if (["verified", "passed", "success", "valid", "approved", "accepted"].includes(value)) {
      return "verified";
    }
    if (["pending", "created", "started"].includes(value)) return "pending";
    if (["expired", "timeout"].includes(value)) return "expired";
    return "failed";
  }
  if (payload.stateInt === 0 || payload.stateInt === "0") return "verified";
  if (payload.stateInt === 2 || payload.stateInt === "2") return "expired";
  return "failed";
}

function ageReplayPayloadHash(value: unknown) {
  const payload = { ...asRecord(value) };
  // Delivery envelope identity may legitimately change on provider redelivery;
  // the signed business payload and target must remain exact.
  delete payload.deliveryId;
  delete payload.originalDeliveryId;
  delete payload.id;
  return canonicalJsonHash(payload);
}

function failedReport(
  base: Omit<AgeProbeReport, "ok" | "durationMs" | "error">,
  startedAt: number,
  error: NonNullable<AgeProbeReport["error"]>,
): AgeProbeReport {
  return {
    ...base,
    ok: false,
    durationMs: Date.now() - startedAt,
    terminal: null,
    error,
  };
}

function sameUrl(left: string | null, right: string | null) {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return false;
  }
}

function isPublicHttpsUrl(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
