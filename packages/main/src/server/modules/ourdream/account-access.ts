import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { jsonBody } from "@/server/lib/request-json";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { clearSessionCookie, createSessionToken, getAuthCtx, hashPassword, requireUser, sessionCookie, verifyPassword } from "@/server/lib/auth";
import { accountDeletionPublicState, accountDeletionSubjectHash, requestAccountDeletion } from "@/server/account-deletion-authority";
import { passwordAccountForUser } from "@/server/lib/auth/password-account";
import { accountMailAvailable } from "@/server/providers/account-mail";
import { accountEmailAddressSchema, accountEmailProofSchema, consumeAccountEmailCode, requestAccountEmailCode, revokeAccountEmailCodes } from "./account-email-challenges";

const YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const passwordSchema = z.string().min(8).max(1024);
const reauthenticationSchema = z.object({ password: z.string().min(1).max(1024), expectedUserId: z.string().min(1), confirmation: z.string().optional() });
const recoverySchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  recoveryCode: z.string().trim().min(1).max(128),
  password: passwordSchema,
});

export function recoveryIdentifier(userId: string) {
  return `account-recovery:${userId}`;
}

export function newRecoveryCode() {
  return randomBytes(24).toString("hex").match(/.{8}/g)!.join("-");
}

function recoveryHash(code: string) {
  return createHash("sha256").update(code.replaceAll("-", "").toLowerCase()).digest("hex");
}

// Only the one-way hash persists. Reissuing and consuming a code share the
// User-root lock with deletion and login so no revoked authority can race back.
export async function storeRecoveryCode(tx: Prisma.TransactionClient, userId: string, code: string) {
  const identifier = recoveryIdentifier(userId);
  await tx.verification.deleteMany({ where: { identifier } });
  const expiresAt = new Date(Date.now() + YEAR_MS);
  await tx.verification.create({ data: { identifier, value: recoveryHash(code), expiresAt } });
  return expiresAt;
}

async function lockActiveUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "active" || user.deletedAt) throw Errors.unauthorized("Account access is no longer active.");
  return user;
}

async function verifyCurrentPassword(tx: Prisma.TransactionClient, userId: string, password: string) {
  const user = await lockActiveUser(tx, userId);
  const account = await passwordAccountForUser(tx, userId);
  if (!account || !verifyPassword(password, account.password)) throw Errors.unauthorized("Current password is incorrect. Try again or use account recovery.");
  return user;
}

export function deletionReceipt(deletionId: string, expiresAt = Date.now() + YEAR_MS) {
  const payload = Buffer.from(JSON.stringify({ id: deletionId, expiresAt })).toString("base64url");
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET).update(`account-deletion-status:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function readDeletionReceipt(token: string, now = Date.now()) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 512) return null;
  const expected = createHmac("sha256", env.BETTER_AUTH_SECRET).update(`account-deletion-status:${payload}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = z.object({ id: z.string().regex(/^account_deletion_[a-f0-9]{32}$/), expiresAt: z.number().int() }).parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return parsed.expiresAt > now ? parsed : null;
  } catch { return null; }
}

async function recoverAccess(request: Request) {
  await enforceRateLimit(request, "authRecovery");
  const body = recoverySchema.parse(await jsonBody(request));
  const code = newRecoveryCode();
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  const userId = await prisma.$transaction(async (tx) => {
    const candidate = await tx.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (candidate) await lockActiveUser(tx, candidate.id);
    const account = candidate ? await passwordAccountForUser(tx, candidate.id) : null;
    const invalid = () => Errors.unauthorized("Email or recovery code is incorrect, expired, or already used. Check your saved code; if you can still log in, generate a new code in Account management.");
    if (!account) throw invalid();
    const proof = await tx.verification.findFirst({ where: { identifier: recoveryIdentifier(account.userId), value: recoveryHash(body.recoveryCode), expiresAt: { gt: new Date() } } });
    if (!proof) throw invalid();
    await tx.verification.delete({ where: { id: proof.id } });
    await tx.account.update({ where: { id: account.id }, data: { password: hashPassword(body.password) } });
    await tx.session.deleteMany({ where: { userId: account.userId } });
    await revokeAccountEmailCodes(tx, body.email);
    await storeRecoveryCode(tx, account.userId, code);
    await tx.session.create({ data: { userId: account.userId, token, expiresAt } });
    return account.userId;
  });
  const response = ok({ recovered: true, userId, recoveryCode: code, recoveryCodeExpiresAt: new Date(Date.now() + YEAR_MS).toISOString() });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}

export async function dispatchAccountAccess(request: Request, segments: string[]): Promise<Response | null> {
  const [resource, action] = segments;
  const emailAccess = await dispatchEmailAccess(request, segments);
  if (emailAccess) return emailAccess;
  if (resource === "auth" && action === "recover" && request.method === "POST") return recoverAccess(request);
  if (resource !== "account") return null;
  if (action === "deletion-status" && request.method === "GET") {
    const proof = readDeletionReceipt(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!proof) throw Errors.unauthorized("This deletion receipt is invalid or expired.");
    const row = await prisma.accountDeletion.findUnique({ where: { id: proof.id } });
    if (!row) return ok({ deletion: null });
    const blobFailure = await prisma.accountDeletionBlobReceipt.findFirst({ where: { deletionId: row.id, lastError: { not: Prisma.DbNull }, status: "pending" }, select: { id: true } });
    const chatFailure = row.chatRequestEventId ? await prisma.mainOutboxEvent.findUnique({ where: { id: row.chatRequestEventId }, select: { lastError: true } }) : null;
    const retrying = Boolean(row.lastError || blobFailure || chatFailure?.lastError);
    return ok({ deletion: { id: row.id, status: row.status, requestedAt: row.requestedAt.toISOString(), graceEndsAt: row.graceEndsAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null, retrying, expiresAt: new Date(proof.expiresAt).toISOString() } });
  }
  if (!["recovery-code", "deletion-receipt", "delete-request"].includes(action ?? "") || request.method !== "POST") return null;
  const user = requireUser(await getAuthCtx(request));
  await enforceRateLimit(request, "accountReauthenticate", user.id);
  const body = reauthenticationSchema.parse(await jsonBody(request));
  if (body.expectedUserId !== user.id) throw Errors.conflict("Your account changed. Reload before changing account security.");
  if (action === "recovery-code") {
    const code = newRecoveryCode();
    const expiresAt = await prisma.$transaction(async (tx) => {
      const active = await verifyCurrentPassword(tx, user.id, body.password);
      await revokeAccountEmailCodes(tx, active.email);
      return storeRecoveryCode(tx, user.id, code);
    });
    return ok({ recoveryCode: code, recoveryCodeExpiresAt: expiresAt.toISOString() });
  }
  if (action === "deletion-receipt") {
    await prisma.$transaction((tx) => verifyCurrentPassword(tx, user.id, body.password));
    return ok({ receipt: deletionReceipt(`account_deletion_${accountDeletionSubjectHash(user.id).slice(0, 32)}`) });
  }
  // The prepare receipt survives an uncertain submit response; it grants only
  // status access, never permission to delete, restore, or read account data.
  if (body.confirmation !== "DELETE") throw Errors.badRequest("Type DELETE to confirm account deletion.");
  const deletion = await prisma.$transaction(async (tx) => {
    await verifyCurrentPassword(tx, user.id, body.password);
    return requestAccountDeletion(tx, { userId: user.id });
  });
  const response = ok({ requested: true, deletion: accountDeletionPublicState(deletion), receipt: deletionReceipt(deletion.id) });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function dispatchEmailAccess(request: Request, segments: string[]): Promise<Response | null> {
  const [resource, action, operation] = segments;
  const reset = resource === "auth" && action === "password-reset";
  const verification = resource === "account" && action === "email-verification";
  if (!reset && !verification) return null;
  if (verification && segments.length === 2 && request.method === "GET") {
    const current = requireUser(await getAuthCtx(request));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: current.id } });
    return ok({ userId: user.id, email: user.email, verified: user.emailVerified, available: accountMailAvailable() });
  }
  if (segments.length !== 3 || request.method !== "POST" || !["request", "confirm"].includes(operation)) return null;
  const payload = await jsonBody(request);
  const email = reset
    ? z.object({ email: accountEmailAddressSchema }).parse(payload).email
    : null;
  const viewer = verification ? requireUser(await getAuthCtx(request)) : null;
  const expectedUserId = verification ? z.object({ expectedUserId: z.string().min(1) }).parse(payload).expectedUserId : undefined;
  if (viewer && expectedUserId !== viewer.id) throw Errors.conflict("Your account changed. Reload before verifying your email.");
  const current = viewer ? await prisma.user.findUniqueOrThrow({ where: { id: viewer.id } }) : null;
  const address = email ?? current!.email;
  const purpose = verification ? "verify_email" as const : "reset_password" as const;
  if (operation === "request") {
    const challenge = await requestAccountEmailCode({ request, email: address, purpose, expectedUserId });
    return ok({ ...challenge, message: "Check the requested mailbox. A code can only verify or recover an eligible account; this response does not confirm that one exists." }, { status: 202 });
  }
  const proof = accountEmailProofSchema.parse(payload);
  if (verification) {
    return ok(await consumeAccountEmailCode({ request, email: address, purpose, expectedUserId, ...proof }, async (tx, user) => {
      await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      return { userId: user.id, verified: true };
    }));
  }
  const { password } = z.object({ password: passwordSchema }).parse(payload);
  const recoveryCode = newRecoveryCode();
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  const result = await consumeAccountEmailCode({ request, email: address, purpose, ...proof }, async (tx, user) => {
    const account = await passwordAccountForUser(tx, user.id);
    if (!account || account.userId !== user.id) throw Errors.unauthorized("Email or code is incorrect, expired, or already used. Request a new code after the cooldown.");
    await tx.account.update({ where: { id: account.id }, data: { password: hashPassword(password) } });
    await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await revokeAccountEmailCodes(tx, address);
    const recoveryCodeExpiresAt = await storeRecoveryCode(tx, user.id, recoveryCode);
    await tx.session.create({ data: { userId: user.id, token, expiresAt } });
    return { recovered: true, userId: user.id, recoveryCode, recoveryCodeExpiresAt: recoveryCodeExpiresAt.toISOString() };
  });
  const response = ok(result);
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}
