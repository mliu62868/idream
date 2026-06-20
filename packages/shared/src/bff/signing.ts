// SPEC: BFF request signing (design §1, §3). main-web signs an internal user
// context; chat verifies. HMAC covers (userId, authTime, method, path, body-hash)
// with a short TTL so a captured signature can't be replayed or retargeted.
// INTENT: The signature proves authn (request really came from main-web for this
// user); chat STILL re-checks authz against read-only views. Transport is mTLS/
// private network — signing is defense-in-depth, not the only control.
// INVARIANTS: body-hash binds the exact body; clock skew bounded by TTL.
// EXAMPLE: signBffContext({secret, userId, method:"POST", path:"/...", body}) → header value
import { createHmac, timingSafeEqual } from "node:crypto";

export const BFF_HEADER = "x-idream-bff" as const;
export const BFF_USER_HEADER = "x-idream-bff-user" as const;
const DEFAULT_TTL_MS = 30_000;

export interface BffContext {
  userId: string;
  authTime: number; // epoch ms
}

function bodyHash(body: string): string {
  return createHmac("sha256", "idream-bff-body").update(body).digest("hex");
}

function canonical(ctx: BffContext, method: string, path: string, body: string): string {
  return [ctx.userId, String(ctx.authTime), method.toUpperCase(), path, bodyHash(body)].join("\n");
}

export function signBffContext(input: {
  secret: string;
  userId: string;
  method: string;
  path: string;
  body: string;
  authTime?: number;
}): { signature: string; context: BffContext } {
  const context: BffContext = { userId: input.userId, authTime: input.authTime ?? nowMs(input) };
  const sig = createHmac("sha256", input.secret)
    .update(canonical(context, input.method, input.path, input.body))
    .digest("hex");
  return { signature: sig, context };
}

export function verifyBffContext(input: {
  secret: string;
  signature: string;
  context: BffContext;
  method: string;
  path: string;
  body: string;
  now: number;
  ttlMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const age = input.now - input.context.authTime;
  if (!Number.isFinite(age) || age < -ttl || age > ttl) {
    return { ok: false, reason: "expired" };
  }
  const expected = createHmac("sha256", input.secret)
    .update(canonical(input.context, input.method, input.path, input.body))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

// `now` is injected via input for testability; callers pass Date.now().
function nowMs(input: { authTime?: number }): number {
  return input.authTime ?? Date.now();
}
