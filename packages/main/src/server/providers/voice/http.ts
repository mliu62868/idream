import { createHash } from "node:crypto";
import type { ProviderResult } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// The deadline includes response bytes, not just HTTP headers. Buffer inside
// this boundary so synthesis, previews, clone JSON and health JSON all release
// their transport resources and report the same retryable timeout.
export async function requestVoiceProvider(input: {
  endpoint: URL;
  init: RequestInit;
  timeoutMs: number;
  fetchImpl: FetchLike;
  providerName: string;
  failureCode: string;
}): Promise<ProviderResult<Response>> {
  const controller = new AbortController();
  const caller = input.init.signal ?? undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer!: ReturnType<typeof setTimeout>;
  let onCallerAbort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    const stop = (message: string) => {
      reject(new DOMException(message, "AbortError"));
      controller.abort();
      void reader?.cancel().catch(() => {});
    };
    timer = setTimeout(() => stop("Voice response timed out"), input.timeoutMs);
    onCallerAbort = () => stop("Voice request was cancelled");
    if (caller?.aborted) onCallerAbort();
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
  });
  try {
    const response = await Promise.race([
      input.fetchImpl(input.endpoint, { ...input.init, signal: controller.signal }), deadline,
    ]);
    reader = response.body?.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    while (reader) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      chunks.push(Uint8Array.from(item.value));
    }
    const body = new Blob(chunks);
    if (!response.ok) {
      const details = await body.text();
      return { ok: false, error: {
        code: response.status === 404 ? "voice_not_found" : input.failureCode,
        message: details.trim() || `${input.providerName} returned HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      } };
    }
    return { ok: true, data: new Response(body.size ? body : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    }) };
  } catch (error) {
    return { ok: false, error: {
      code: caller?.aborted ? "voice_cancelled" : error instanceof Error && error.name === "AbortError" ? "voice_timeout" : "voice_request_failed",
      message: error instanceof Error ? error.message : `${input.providerName} request failed`, retryable: true,
    } };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
    reader?.releaseLock();
  }
}
export function voiceEndpoint(baseUrl: string, suffix: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix.replace(/^\//, ""), normalized);
}

export function voiceFailure(code: string, message: string, retryable: boolean): ProviderResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

export function ownedArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function voiceOwnerHeaders(ownerId?: string): Record<string, string> {
  return ownerId ? { "x-idream-owner-hash": createHash("sha256").update(ownerId).digest("hex") } : {};
}
