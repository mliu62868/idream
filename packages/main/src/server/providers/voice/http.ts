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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DOMException("Voice response timed out", "AbortError"));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, input.timeoutMs);
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
      code: error instanceof Error && error.name === "AbortError" ? "voice_timeout" : "voice_request_failed",
      message: error instanceof Error ? error.message : `${input.providerName} request failed`, retryable: true,
    } };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
export function voiceOwnerHeaders(ownerId?: string): Record<string, string> {
  return ownerId ? { "x-idream-owner-hash": createHash("sha256").update(ownerId).digest("hex") } : {};
}
