import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { passwordAccountForUser } from "@/server/lib/auth/password-account";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { rateLimitIdentity } from "@/server/lib/rate-limit";
import { requireAccountMail, sendAccountEmail, type AccountEmailPurpose } from "@/server/providers/account-mail";

const CODE_LIFETIME_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_CODE_ATTEMPTS = 5;
const PREFIX = "account-email:";
const proofSchema = z.object({
  purpose: z.enum(["verify_email", "reset_password"]),
  emailHash: z.string().length(64),
  userId: z.string().nullable(),
  codeHash: z.string().length(64),
  attempts: z.number().int().min(0).max(MAX_CODE_ATTEMPTS),
  delivery: z.object({ provider: z.literal("resend"), requestId: z.string().uuid() }).nullable(),
});
type Proof = z.infer<typeof proofSchema>;

export const accountEmailAddressSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
export const accountEmailProofSchema = z.object({
  challengeId: z.string().regex(/^account-email:proof:[a-f0-9]{48}$/),
  code: z.string().trim().regex(/^\d{8}$/),
});

function digest(value: string) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(`${PREFIX}v1:${value}`).digest("hex");
}

export function accountEmailIdentifier(purpose: AccountEmailPurpose, email: string) {
  return `${PREFIX}${purpose}:${digest(email)}`;
}

// The caller holds the User root lock when credentials are replaced or access
// ends. Outstanding email proofs must not outlive that security transition.
export async function revokeAccountEmailCodes(tx: Prisma.TransactionClient, email: string) {
  await tx.verification.deleteMany({ where: { identifier: { in: [
    accountEmailIdentifier("verify_email", email),
    accountEmailIdentifier("reset_password", email),
  ] } } });
}

function codeHash(id: string, purpose: AccountEmailPurpose, email: string, code: string) {
  return digest(`${id}:${purpose}:${email}:${code}`);
}

async function lock(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// Verification.identifier intentionally is not unique (Better Auth has its own
// semantics). Only our deterministic IDs/namespace are used for rate counters;
// advisory locks serialize our one-current-proof invariant without changing it.
async function consumeLimits(request: Request, email: string, sending: boolean) {
  // Bound retention/work without touching Better Auth or recovery-code rows.
  // Repeat the expiry predicate on delete so a refreshed counter is preserved.
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const expired = await prisma.verification.findMany({
    where: { identifier: { startsWith: PREFIX }, expiresAt: { lt: cutoff } },
    select: { id: true }, take: 100,
  });
  if (expired.length) await prisma.verification.deleteMany({ where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lt: cutoff } } });
  const policies = sending ? [
    { key: `send-ip:${rateLimitIdentity(request, undefined)}`, limit: 20, windowMs: 60 * 60_000 },
    { key: `send-email:${email}`, limit: 5, windowMs: 60 * 60_000 },
    { key: `resend-email:${email}`, limit: 1, windowMs: RESEND_COOLDOWN_MS },
  ] : [
    { key: `check-ip:${rateLimitIdentity(request, undefined)}`, limit: 30, windowMs: 15 * 60_000 },
  ];
  const limits = policies.map((policy) => ({ ...policy, id: `${PREFIX}rate:${digest(policy.key)}` })).sort((a, b) => a.id.localeCompare(b.id));
  // INTENT: durable and fail-closed. The shared Redis limiter deliberately fails
  // open; account email codes are an enumeration and abuse surface, so their
  // counters live in PostgreSQL under advisory locks instead.
  const retryAfterMs = await prisma.$transaction(async (tx) => {
    const now = Date.now();
    const counters = [];
    for (const policy of limits) {
      await lock(tx, policy.id);
      const row = await tx.verification.findUnique({ where: { id: policy.id } });
      const current = row && row.expiresAt.getTime() > now ? row : null;
      counters.push({ policy, current, count: current ? Number(current.value) : 0 });
    }
    // A refused request consumes no allowance: every counter is checked before
    // any is incremented, so a resend-cooldown refusal cannot spend the hourly ceiling.
    const retry = Math.max(0, ...counters
      .filter(({ policy, count }) => !Number.isSafeInteger(count) || count >= policy.limit)
      .map(({ policy, current }) => (current?.expiresAt.getTime() ?? now + policy.windowMs) - now));
    if (retry > 0) return retry;
    for (const { policy, current, count } of counters) {
      await tx.verification.upsert({
        where: { id: policy.id },
        create: { id: policy.id, identifier: `${PREFIX}rate`, value: "1", expiresAt: new Date(now + policy.windowMs) },
        update: { value: String(count + 1), expiresAt: current?.expiresAt ?? new Date(now + policy.windowMs) },
      });
    }
    return 0;
  });
  if (retryAfterMs > 0) throw Errors.rateLimited("Too many email-code requests. Wait before trying again.", { retryAfterMs });
}

async function activeUser(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${id} FOR UPDATE`);
  const user = await tx.user.findUnique({ where: { id } });
  return user?.status === "active" && !user.deletedAt ? user : null;
}

export async function requestAccountEmailCode(input: {
  request: Request;
  email: string;
  purpose: AccountEmailPurpose;
  expectedUserId?: string;
}) {
  requireAccountMail();
  await consumeLimits(input.request, input.email, true);
  const id = `${PREFIX}proof:${randomBytes(24).toString("hex")}`;
  const code = String(randomInt(100_000_000)).padStart(8, "0");
  const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
  const identifier = accountEmailIdentifier(input.purpose, input.email);
  await prisma.$transaction(async (tx) => {
    const candidate = input.expectedUserId
      ? await tx.user.findUnique({ where: { id: input.expectedUserId } })
      : await tx.user.findUnique({ where: { email: input.email } });
    const user = candidate ? await activeUser(tx, candidate.id) : null;
    if (input.expectedUserId && (!user || user.email !== input.email)) {
      throw Errors.conflict("Your account changed. Reload before verifying your email.");
    }
    const credential = user && input.purpose === "reset_password"
      ? await passwordAccountForUser(tx, user.id)
      : null;
    const proof: Proof = {
      purpose: input.purpose,
      emailHash: digest(input.email),
      userId: user && (input.purpose === "verify_email" || credential?.userId === user.id) ? user.id : null,
      codeHash: codeHash(id, input.purpose, input.email, code),
      attempts: 0,
      delivery: null,
    };
    await lock(tx, identifier);
    await tx.verification.deleteMany({ where: { identifier } });
    await tx.verification.create({ data: { id, identifier, value: JSON.stringify(proof), expiresAt } });
  });

  try {
    // The same neutral email is submitted for unknown/inactive addresses. The
    // request status, provider errors and timing therefore do not enumerate
    // accounts. Such a challenge has no user authority and can never reset one.
    const delivery = await sendAccountEmail({ email: input.email, code, challengeId: id, purpose: input.purpose });
    await prisma.$transaction(async (tx) => {
      await lock(tx, identifier);
      const row = await tx.verification.findUnique({ where: { id } });
      if (!row) throw Errors.conflict("A newer email code was requested. Use the most recent code.");
      const proof = proofSchema.parse(JSON.parse(row.value));
      await tx.verification.update({ where: { id }, data: { value: JSON.stringify({ ...proof, delivery }) } });
    });
  } catch (error) {
    // An uncertain provider response never grants usable authority. A late
    // failure only removes its own challenge, never a more recent resend.
    await prisma.verification.deleteMany({ where: { id } });
    throw error;
  }
  return { challengeId: id, expiresAt: expiresAt.toISOString(), resendAt: new Date(Date.now() + RESEND_COOLDOWN_MS).toISOString() };
}

export async function consumeAccountEmailCode<T>(input: {
  request: Request;
  email: string;
  purpose: AccountEmailPurpose;
  challengeId: string;
  code: string;
  expectedUserId?: string;
}, apply: (tx: Prisma.TransactionClient, user: User) => Promise<T>): Promise<T> {
  await consumeLimits(input.request, input.email, false);
  const identifier = accountEmailIdentifier(input.purpose, input.email);
  // The initial read discovers only the User lock key. Re-read the entire proof
  // under both locks; never authorize from this unlocked snapshot.
  const candidate = await prisma.verification.findUnique({ where: { id: input.challengeId } });
  const parsed = candidate ? proofSchema.safeParse(JSON.parse(candidate.value)) : null;
  const userId = parsed?.success ? parsed.data.userId : null;
  const result = await prisma.$transaction(async (tx) => {
    // Keep User -> email-proof lock order, shared with issuing/revoking recovery
    // credentials and account deletion. No email proof can revive a deleted user.
    const user = userId ? await activeUser(tx, userId) : null;
    await lock(tx, identifier);
    const row = await tx.verification.findUnique({ where: { id: input.challengeId } });
    if (!row || row.identifier !== identifier) return { valid: false } as const;
    const proof = proofSchema.parse(JSON.parse(row.value));
    if (row.expiresAt.getTime() <= Date.now() || proof.attempts >= MAX_CODE_ATTEMPTS) {
      await tx.verification.delete({ where: { id: row.id } });
      return { valid: false } as const;
    }
    if (!proof.delivery) return { valid: false } as const;
    const expected = Buffer.from(proof.codeHash, "hex");
    const actual = Buffer.from(codeHash(row.id, input.purpose, input.email, input.code), "hex");
    const valid = timingSafeEqual(actual, expected) && proof.purpose === input.purpose &&
      proof.emailHash === digest(input.email) && user && user.id === proof.userId &&
      user.email === input.email && (!input.expectedUserId || user.id === input.expectedUserId);
    if (!valid) {
      await tx.verification.update({ where: { id: row.id }, data: { value: JSON.stringify({ ...proof, attempts: proof.attempts + 1 }) } });
      // Return rather than throw so failed-attempt accounting commits.
      return { valid: false } as const;
    }
    await tx.verification.delete({ where: { id: row.id } });
    return { valid: true, value: await apply(tx, user) } as const;
  });
  if (!result.valid) throw Errors.unauthorized("Email or code is incorrect, expired, or already used. Request a new code after the cooldown.");
  return result.value;
}
