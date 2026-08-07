import type { GenerationTransportExecutionEvent } from "@idream/shared/contracts";
import { env } from "./env";

export async function recordTransportExecution(input: GenerationTransportExecutionEvent): Promise<void> {
  const response = await fetch(env.MAIN_GENERATION_TRANSPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const evidence = await response.text().catch(() => "");
    const detail = boundedTransportErrorEvidence(evidence);
    throw new Error(
      `main generation transport endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
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
