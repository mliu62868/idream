import { UnrecoverableError } from "bullmq";
import {
  GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON,
  type GenerationTransportExecutionEvent,
} from "@idream/shared/contracts";
import { env } from "./env";

export class GenerationTransportUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationTransportUnavailableError";
  }
}

// SPEC: Main has made this Attempt terminal (a user cancel, usually), so no retry of
// this Bull row can ever pass its authority check.
// INTENT: extends UnrecoverableError so BullMQ stops at once. A plain Error would
// retry with backoff, and on the single-slot video worker each retry re-prepares the
// inputs and goes back to the device queue only to be refused again. The failed row
// that remains is history: nothing recovers it without a durable terminal record.
// INVARIANT: this is never a provider outcome, so no terminal record may be written
// for it.
export class GenerationAuthorityRevokedError extends UnrecoverableError {}

export function isGenerationAuthorityRevoked(error: unknown): boolean {
  return error instanceof GenerationAuthorityRevokedError;
}

export async function recordTransportExecution(input: GenerationTransportExecutionEvent): Promise<void> {
  let response: Response;
  try {
    response = await fetch(env.MAIN_GENERATION_TRANSPORT_URL, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new GenerationTransportUnavailableError(
      error instanceof Error ? error.message : "Main generation transport unavailable",
      { cause: error },
    );
  }
  if (!response.ok) {
    const evidence = await response.text().catch(() => "");
    const detail = boundedTransportErrorEvidence(evidence);
    const message = `main generation transport endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`;
    // A 4xx is Main's authority rejection, not evidence of service unavailability.
    if (response.status >= 500) throw new GenerationTransportUnavailableError(message);
    if (transportRejectionReason(evidence) === GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON) {
      throw new GenerationAuthorityRevokedError(message);
    }
    // Every other 4xx keeps retrying: a deferred scene becomes executable later, and
    // a 401 is a deployment fault that must not throw away paid work.
    throw new Error(message);
  }
}

function transportRejectionReason(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as { reason?: unknown }).reason : undefined;
  } catch {
    return undefined;
  }
}

// INTENT: preserve Main's structured conflict reason in worker failure evidence
// without allowing an upstream HTML/error response to flood BullMQ or PM2 logs.
function boundedTransportErrorEvidence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 997)}...`;
}
