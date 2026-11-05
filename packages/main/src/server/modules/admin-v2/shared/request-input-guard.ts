import { ADMIN_IDEMPOTENCY_KEY_MAX_LENGTH } from "@idream/shared/admin/contracts";
import { Errors } from "@/server/lib/errors";

const NUL = "\u0000";

/**
 * SPEC: Reject request-line and header input that no Admin v2 operation can legitimately carry,
 * before any handler sees it.
 * INTENT: Postgres text cannot hold NUL, so a `%00` in a search term or path id reached the driver
 * and surfaced as a 500 (`invalid byte sequence`). Every Admin v2 Route Handler leaves through
 * `adminV2Route`, which makes this the one place that covers them all; a per-schema check would
 * miss every id that is read straight from the path.
 * INVARIANT: runs on untrusted input only and reveals nothing about authority, so it is safe ahead
 * of authentication.
 */
export function assertAdminRequestEnvelopeInput(request: Request) {
  const url = new URL(request.url);
  if (/%00/i.test(url.pathname)) {
    throw Errors.badRequest("Request path contains an invalid NUL byte");
  }
  for (const [name, value] of url.searchParams) {
    if (name.includes(NUL) || value.includes(NUL)) {
      throw Errors.badRequest("Request query contains an invalid NUL byte");
    }
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (idempotencyKey && idempotencyKey.length > ADMIN_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw Errors.badRequest("Idempotency-Key header is too long", {
      maxLength: ADMIN_IDEMPOTENCY_KEY_MAX_LENGTH,
    });
  }
}

/** The request body half of the same rule; JSON can spell NUL as `\u0000` anywhere in a value. */
export function assertNoNulInRequestBody(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes(NUL)) throw Errors.badRequest("Request body contains an invalid NUL byte");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoNulInRequestBody);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      assertNoNulInRequestBody(name);
      assertNoNulInRequestBody(child);
    }
  }
}
