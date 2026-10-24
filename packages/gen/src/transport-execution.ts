import type { GenerationTransportExecutionEvent } from "@idream/shared/contracts";
import { env } from "./env";

export class GenerationTransportUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationTransportUnavailableError";
  }
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
    throw new Error(message);
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
