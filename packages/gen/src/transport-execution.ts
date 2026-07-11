import type { GenerationTransportExecutionEvent } from "@idream/shared/contracts";
import { env } from "./env";

export async function recordTransportExecution(input: GenerationTransportExecutionEvent): Promise<void> {
  const response = await fetch(env.MAIN_GENERATION_TRANSPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`main generation transport endpoint returned ${response.status}`);
}
