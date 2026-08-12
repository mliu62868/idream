import {
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  mainToChatReceiverAuthorityResponseSchema,
  mainToChatTargetMissingDispositionResponseSchema,
  type DurableEventEnvelope,
  type MainToChatReceiverAuthority,
  type MainToChatTargetIdentity,
  type MainToChatTargetMissingDispositionResponse,
} from "@idream/shared/contracts";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";

const INTERNAL_BATCH_SIZE = 50;
const INTERNAL_TIMEOUT_MS = 10_000;

export async function inspectChatReceiverAuthority(
  events: readonly DurableEventEnvelope[],
): Promise<readonly MainToChatReceiverAuthority[]> {
  const results: MainToChatReceiverAuthority[] = [];
  for (const batch of chunks(events, INTERNAL_BATCH_SIZE)) {
    const response = await postChatAuthority(
      "/internal/events/main-outbox-authority",
      { events: batch },
      mainToChatReceiverAuthorityResponseSchema,
    );
    results.push(...response.results);
  }
  return results;
}

export async function discardChatReceiverTargetMissing(
  events: readonly {
    readonly envelope: DurableEventEnvelope;
    readonly expectedEnvelopeHash: string;
    readonly expectedTarget: MainToChatTargetIdentity;
  }[],
): Promise<readonly MainToChatTargetMissingDispositionResponse["results"][number][]> {
  const results: MainToChatTargetMissingDispositionResponse["results"][number][] = [];
  for (const batch of chunks(events, INTERNAL_BATCH_SIZE)) {
    const response = await postChatAuthority(
      "/internal/events/discard-target-missing",
      {
        events: batch,
        confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
      },
      mainToChatTargetMissingDispositionResponseSchema,
    );
    results.push(...response.results);
  }
  return results;
}

async function postChatAuthority<T>(
  path: string,
  body: unknown,
  schema: { readonly parse: (value: unknown) => T },
): Promise<T> {
  if (!env.CHAT_SERVICE_URL) {
    throw Errors.unavailable("Chat receiver authority is not configured", {
      reason: "missing_chat_service_url",
    });
  }
  let response: Response;
  try {
    response = await fetch(
      `${env.CHAT_SERVICE_URL.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": env.INTERNAL_TOKEN,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INTERNAL_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    throw Errors.unavailable("Chat receiver authority is unreachable", {
      reason: cause instanceof Error ? cause.name : "fetch_failed",
    });
  }
  if (!response.ok) {
    throw Errors.unavailable("Chat receiver authority rejected the request", {
      upstreamStatus: response.status,
    });
  }
  try {
    return schema.parse(await response.json());
  } catch {
    throw Errors.unavailable("Chat receiver authority returned invalid evidence", {
      upstreamStatus: response.status,
    });
  }
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
