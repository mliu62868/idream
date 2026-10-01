import { voiceInputResultSchema, type VoiceInputResult } from "@idream/shared/contracts";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";

export type AsrScope = { userId: string; conversationId: string; requestId: string };
export function asrConfigured() {
  return env.ASR_PROVIDER === "parakeet-redux" && Boolean(env.PARAKEET_ASR_API_TOKEN);
}
function headers(scope?: AsrScope) {
  return {
    authorization: `Bearer ${env.PARAKEET_ASR_API_TOKEN}`,
    ...(scope ? { "x-asr-user-id": scope.userId, "x-asr-conversation-id": scope.conversationId,
      "x-asr-request-id": scope.requestId, "idempotency-key": scope.requestId } : {}),
  };
}
export async function asrReady(): Promise<boolean> {
  if (!asrConfigured()) return false;
  try {
    const response = await fetch(`${env.PARAKEET_ASR_API_URL.replace(/\/$/, "")}/health`, { headers: headers(), signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!response.ok) return false;
    const health = await response.json() as { ready?: boolean; model?: string; modelRevision?: string; runtimeVersion?: string };
    return health.ready === true && health.model === "moondream/parakeet-redux" && health.modelRevision === "2bf128600aac4b16946f7ed8372e56117fe5e23b" && health.runtimeVersion === "2.6.1";
  } catch { return false; }
}
export async function requestAsr(method: "POST" | "GET" | "DELETE", scope: AsrScope, audio?: Blob): Promise<VoiceInputResult> {
  if (!asrConfigured()) throw Errors.unavailable("Voice input is not configured");
  let response: Response;
  try {
    response = await fetch(`${env.PARAKEET_ASR_API_URL.replace(/\/$/, "")}/v1/transcriptions${method === "POST" ? "" : `/${scope.requestId}`}`, {
      method, headers: { ...headers(scope), ...(audio ? { "content-type": audio.type || "application/octet-stream" } : {}) },
      body: audio, signal: AbortSignal.timeout(method === "POST" ? 32_000 : 5000), cache: "no-store",
    });
  } catch { throw Errors.unavailable("Couldn't transcribe your recording. Check this request before retrying", { requestId: scope.requestId }); }
  if (!response.ok) {
    let details: { errorCode?: string; detail?: string; retryAfterMs?: number } = {};
    try { details = await response.json(); } catch { /* Upstream diagnostics never expose audio or text. */ }
    const safeDetails = { requestId: scope.requestId, errorCode: typeof (details.errorCode ?? details.detail) === "string" ? String(details.errorCode ?? details.detail).slice(0, 80) : "gateway_error", retryAfterMs: typeof details.retryAfterMs === "number" ? details.retryAfterMs : Number(response.headers.get("retry-after")) > 0 ? Number(response.headers.get("retry-after")) * 1000 : undefined };
    if (response.status === 409) throw Errors.conflict("This recording key was already used", safeDetails);
    if (response.status === 429) throw Errors.rateLimited("Voice input is busy. Try again shortly", safeDetails);
    if (response.status === 404 || response.status === 410) throw Errors.gone("This transcription expired or is unknown", safeDetails);
    if (response.status === 400 || response.status === 413 || response.status === 422) throw Errors.badRequest("The recording is invalid, too large, or too long", safeDetails);
    throw Errors.unavailable("Couldn't transcribe your recording", safeDetails);
  }
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.expiresAt === "number") payload.expiresAt = new Date(payload.expiresAt).toISOString();
  const result = voiceInputResultSchema.safeParse(payload);
  if (!result.success || result.data.requestId !== scope.requestId) throw Errors.unavailable("Invalid voice input service response");
  return result.data;
}
