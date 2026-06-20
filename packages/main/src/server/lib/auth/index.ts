import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { User } from "@prisma/client";
import { auth } from "@/server/lib/better-auth";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "../errors";

export interface AuthCtx {
  userId?: string;
  role?: "user" | "moderator" | "admin";
  anonymousId?: string;
  ageGateAccepted: boolean;
  ageVerificationStatus: "not_required" | "required" | "pending" | "verified" | "failed" | "expired";
}

export const SESSION_COOKIE = "idream_session";
export const ANONYMOUS_COOKIE = "idream_anonymous_id";
export const AGE_GATE_COOKIE = "AdultContentAcceptedOD";
const passwordPrefix = "scrypt";

export function parseCookieHeader(header: string | null) {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
  }

  return cookies;
}

export function createAnonymousId() {
  return `anon_${randomBytes(16).toString("hex")}`;
}

export function createSessionToken() {
  return `sess_${randomBytes(32).toString("hex")}`;
}

export function sessionCookie(token: string, expiresAt: Date) {
  return serializeCookie(SESSION_COOKIE, token, {
    expires: expiresAt,
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_ENV === "production",
    path: "/",
  });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_ENV === "production",
    path: "/",
  });
}

export function ageGateCookie() {
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
  return serializeCookie(AGE_GATE_COOKIE, "true", {
    expires,
    sameSite: "lax",
    secure: env.APP_ENV === "production",
    path: "/",
  });
}

export function anonymousCookie(anonymousId: string) {
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
  return serializeCookie(ANONYMOUS_COOKIE, anonymousId, {
    expires,
    sameSite: "lax",
    secure: env.APP_ENV === "production",
    path: "/",
  });
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${passwordPrefix}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [prefix, salt, hash] = stored.split("$");
  if (prefix !== passwordPrefix || !salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function getAuthCtx(request?: Request): Promise<AuthCtx> {
  const headers = request?.headers;
  const cookies = parseCookieHeader(headers?.get("cookie") ?? null);
  const anonymousId =
    cookies.get(ANONYMOUS_COOKIE) ??
    headers?.get("x-idream-anonymous-id") ??
    undefined;
  const ageGateCookieAccepted = cookies.get(AGE_GATE_COOKIE) === "true";

  const devUserId =
    env.APP_ENV !== "production" ? headers?.get("x-idream-user-id") : undefined;
  const devUser = devUserId ? await findActiveUser(devUserId) : null;
  const cookieUser = devUser ? null : await userFromCustomSession(cookies.get(SESSION_COOKIE));
  const betterAuthUser = devUser || cookieUser ? null : await userFromBetterAuth(request);
  const user = devUser ?? cookieUser ?? betterAuthUser;

  const acceptedInDb = await hasAgeGateAcceptance({
    userId: user?.id,
    anonymousId,
  });
  const verificationStatus = user
    ? await getAgeVerificationStatus(user.id)
    : "not_required";

  return {
    userId: user?.id,
    role: roleFromUser(user, headers?.get("x-idream-role")),
    anonymousId,
    ageGateAccepted: ageGateCookieAccepted || acceptedInDb,
    ageVerificationStatus: verificationStatus,
  };
}

export function requireUser(ctx: AuthCtx) {
  if (!ctx.userId) throw Errors.unauthorized();
  return { id: ctx.userId, role: ctx.role ?? "user" };
}

export function requireAdmin(ctx: AuthCtx) {
  const user = requireUser(ctx);
  if (user.role !== "admin") throw Errors.forbidden();
  return user;
}

export function requireAgeGate(ctx: AuthCtx) {
  if (!ctx.ageGateAccepted) {
    throw Errors.forbidden("Age gate acceptance required", {
      reason: "age_gate_required",
    });
  }
}

export function requireAgeVerified(ctx: AuthCtx) {
  if (
    ctx.ageVerificationStatus !== "not_required" &&
    ctx.ageVerificationStatus !== "verified"
  ) {
    throw Errors.forbidden("Age verification required", {
      status: ctx.ageVerificationStatus,
    });
  }
}

export async function mergeAnonymous(userId: string, anonymousId?: string) {
  if (!anonymousId) return;

  await prisma.$transaction([
    prisma.ageGateAcceptance.updateMany({
      where: { anonymousId, userId: null },
      data: { userId },
    }),
    prisma.analyticsEvent.updateMany({
      where: { anonymousId, userId: null },
      data: { userId },
    }),
  ]);
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires?: Date;
    httpOnly?: boolean;
    sameSite?: "lax" | "strict" | "none";
    secure?: boolean;
    path?: string;
  },
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  if (options.path) parts.push(`Path=${options.path}`);
  return parts.join("; ");
}

async function findActiveUser(userId: string) {
  return prisma.user.findFirst({
    where: {
      id: userId,
      status: "active",
      deletedAt: null,
    },
  });
}

async function userFromCustomSession(token?: string) {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session || session.expiresAt <= new Date()) return null;
  if (session.user.status !== "active" || session.user.deletedAt) return null;
  return session.user;
}

async function userFromBetterAuth(request?: Request) {
  if (!request) return null;

  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });
    const userId = session?.user?.id;
    return userId ? findActiveUser(userId) : null;
  } catch {
    return null;
  }
}

function roleFromUser(user: User | null, devRole?: string | null) {
  if (env.APP_ENV !== "production" && devRole) {
    if (devRole === "admin" || devRole === "moderator" || devRole === "user") {
      return devRole;
    }
  }

  if (user?.role === "admin" || user?.role === "moderator") return user.role;
  return user ? "user" : undefined;
}

async function hasAgeGateAcceptance(input: {
  userId?: string;
  anonymousId?: string;
}) {
  if (!input.userId && !input.anonymousId) return false;

  const acceptance = await prisma.ageGateAcceptance.findFirst({
    where: {
      OR: [
        input.userId ? { userId: input.userId } : {},
        input.anonymousId ? { anonymousId: input.anonymousId } : {},
      ].filter((item) => Object.keys(item).length > 0),
    },
    select: { id: true },
  });

  return Boolean(acceptance);
}

async function getAgeVerificationStatus(userId: string) {
  const latest = await prisma.ageVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });

  switch (latest?.status) {
    case "required":
    case "pending":
    case "verified":
    case "failed":
    case "expired":
    case "not_required":
      return latest.status;
    default:
      return "not_required";
  }
}
