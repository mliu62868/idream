import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { api, cookieHeader, expectError, expectOk } from "@/server/test/helpers";
import { Errors } from "@/server/lib/errors";
import { accountDeletionSubjectHash, requestAccountDeletion } from "@/server/account-deletion-authority";
import { recoveryIdentifier } from "./account-access";
import { accountEmailIdentifier } from "./account-email-challenges";

const mail = vi.hoisted(() => ({
  available: true,
  send: vi.fn<(input: { email: string; code: string; challengeId: string; purpose: "verify_email" | "reset_password" }) => Promise<{ provider: "resend"; requestId: string }>>(),
}));
vi.mock("@/server/providers/account-mail", async () => {
  const { Errors: errors } = await import("@/server/lib/errors");
  return {
    accountMailAvailable: () => mail.available,
    requireAccountMail: () => { if (!mail.available) throw errors.unavailable("Email verification and password reset are temporarily unavailable. Use a saved recovery code or try again later."); },
    sendAccountEmail: mail.send,
  };
});

const startedAt = new Date();
const runId = randomUUID().slice(0, 8);
const ids: string[] = [];
const emails: string[] = [];
const password = "Original-account-password!";
let sequence = 0;
function address(label: string) {
  const email = `zt-email-${runId}-${label}@customer.invalid`;
  emails.push(email);
  return email;
}
function ip() { return { "x-forwarded-for": `192.0.2.${++sequence}` }; }
async function signup(label: string) {
  const email = address(label);
  const result = await api("POST", "auth/signup", { body: { email, password, name: "Controlled email recovery" } });
  expectOk(result);
  ids.push(result.data.user.id);
  return { email, id: result.data.user.id as string, code: result.data.recoveryCode as string, cookie: cookieHeader(result.setCookies), headers: ip() };
}
type Fixture = Awaited<ReturnType<typeof signup>>;
async function requestReset(user: Pick<Fixture, "email" | "headers">) {
  const result = await api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers });
  expectOk(result, 202);
  const submitted = mail.send.mock.calls.findLast(([input]) => input.challengeId === result.data.challengeId)?.[0];
  expect(submitted).toBeDefined();
  return { ...result.data, code: submitted!.code } as { challengeId: string; code: string; expiresAt: string; resendAt: string };
}
async function confirmReset(user: Pick<Fixture, "email" | "headers">, challenge: { challengeId: string; code: string }, nextPassword = "Changed-account-password!") {
  return api("POST", "auth/password-reset/confirm", { body: { email: user.email, challengeId: challenge.challengeId, code: challenge.code, password: nextPassword }, headers: user.headers });
}
function advancePastCooldown() {
  const now = Date.now() + 61_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
}

beforeEach(() => {
  mail.available = true;
  mail.send.mockReset();
  mail.send.mockResolvedValue({ provider: "resend", requestId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.accountDeletion.deleteMany({ where: { subjectHash: { in: ids.map(accountDeletionSubjectHash) } } });
  await prisma.verification.deleteMany({ where: { OR: [
    { identifier: { in: ids.map(recoveryIdentifier) } },
    { identifier: { in: emails.flatMap((email) => [accountEmailIdentifier("verify_email", email), accountEmailIdentifier("reset_password", email)]) } },
    { identifier: "account-email:rate", createdAt: { gte: startedAt } },
  ] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("Main email verification and password recovery authority", () => {
  it("stores only a bound HMAC, resets credentials once, revokes old sessions and rotates the saved recovery code", async () => {
    const user = await signup("reset");
    const challenge = await requestReset(user);
    expect(challenge.code).toMatch(/^\d{8}$/);
    const stored = await prisma.verification.findUniqueOrThrow({ where: { id: challenge.challengeId } });
    const proof = JSON.parse(stored.value);
    expect(proof).toMatchObject({ userId: user.id, purpose: "reset_password", delivery: { provider: "resend", requestId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }, attempts: 0 });
    expect(proof.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.codeHash).not.toBe(challenge.code);
    expect(proof).not.toHaveProperty("code");
    expect(stored.value).not.toContain(user.email);
    const reset = await confirmReset(user, challenge);
    expectOk(reset);
    expect(reset.data.recoveryCode).not.toBe(user.code);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await api("GET", "me", { cookie: user.cookie })).data.user).toBeNull();
    expect((await api("GET", "me", { cookie: cookieHeader(reset.setCookies) })).data.user.id).toBe(user.id);
    expectError(await api("POST", "auth/login", { body: { email: user.email, password } }), 401);
    expectOk(await api("POST", "auth/login", { body: { email: user.email, password: "Changed-account-password!" } }));
    expectError(await confirmReset(user, challenge), 401);
    expectError(await api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password } }), 401);
  });

  it("fails closed when one user has more than one password credential", async () => {
    const user = await signup("ambiguous");
    await prisma.account.create({ data: { userId: user.id, providerId: "credential", accountId: `${user.id}:duplicate`, password: hashPassword("Duplicate-account-password!") } });
    const before = await prisma.account.findMany({ where: { userId: user.id }, orderBy: { id: "asc" }, select: { id: true, password: true } });
    expectError(await api("POST", "auth/login", { body: { email: user.email, password } }), 401);
    expectError(await confirmReset(user, await requestReset(user)), 401);
    expectError(await api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password: "Changed-account-password!" } }), 401);
    expect(await prisma.account.findMany({ where: { userId: user.id }, orderBy: { id: "asc" }, select: { id: true, password: true } })).toEqual(before);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("serializes concurrent consumers so only one new session and password can win", async () => {
    const user = await signup("consume-race");
    const challenge = await requestReset(user);
    const results = await Promise.all([confirmReset(user, challenge, "First-password!"), confirmReset(user, challenge, "Second-password!")]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.verification.findUnique({ where: { id: challenge.challengeId } })).toBeNull();
  });

  it("enforces one concurrent issue, a resend cooldown, and invalidates the previous code", async () => {
    const user = await signup("resend");
    const request = () => api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers });
    const issued = await Promise.all([request(), request()]);
    expect(issued.map((result) => result.status).sort()).toEqual([202, 429]);
    expect(mail.send).toHaveBeenCalledOnce();
    const old = mail.send.mock.calls[0][0];
    advancePastCooldown();
    const replacement = await requestReset(user);
    expect(replacement.challengeId).not.toBe(old.challengeId);
    expectError(await confirmReset(user, old), 401);
    expectOk(await confirmReset(user, replacement));
  });

  it("commits failed attempts across IP changes and expires the proof after five guesses", async () => {
    const user = await signup("guess-limit");
    const challenge = await requestReset(user);
    const wrong = challenge.code === "00000000" ? "00000001" : "00000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      expectError(await confirmReset({ ...user, headers: ip() }, { ...challenge, code: wrong }), 401);
    }
    expect(JSON.parse((await prisma.verification.findUniqueOrThrow({ where: { id: challenge.challengeId } })).value).attempts).toBe(5);
    expectError(await confirmReset(user, challenge), 401);
    expectOk(await api("POST", "auth/login", { body: { email: user.email, password } }));
  });

  it("rejects expired and wrong-address codes without changing either account", async () => {
    const a = await signup("wrong-a");
    const b = await signup("wrong-b");
    const challenge = await requestReset(a);
    expectError(await confirmReset(b, challenge), 401);
    await prisma.verification.update({ where: { id: challenge.challengeId }, data: { expiresAt: new Date(0) } });
    expectError(await confirmReset(a, challenge), 401);
    expect(await prisma.verification.findUnique({ where: { id: challenge.challengeId } })).toBeNull();
    expectOk(await api("POST", "auth/login", { body: { email: a.email, password } }));
    expectOk(await api("POST", "auth/login", { body: { email: b.email, password } }));
  });

  it("uses the same provider request and public envelope for unknown accounts, but grants them no authority", async () => {
    const unknown = { email: address("unknown"), headers: ip() };
    const challenge = await requestReset(unknown);
    expect(mail.send.mock.calls[0][0]).toMatchObject({ email: unknown.email, purpose: "reset_password" });
    const proof = JSON.parse((await prisma.verification.findUniqueOrThrow({ where: { id: challenge.challengeId } })).value);
    expect(proof.userId).toBeNull();
    const rejected = await confirmReset(unknown, challenge);
    expectError(rejected, 401);
    expect(rejected.error?.message).toBe("Email or code is incorrect, expired, or already used. Request a new code after the cooldown.");
    expect(await prisma.user.findUnique({ where: { email: unknown.email } })).toBeNull();
    const later = await api("POST", "auth/signup", { body: { email: unknown.email, password, name: "Created after request" } });
    expectOk(later); ids.push(later.data.user.id);
    expectError(await confirmReset(unknown, challenge), 401);
  });

  it("fails closed when email is disabled or delivery is uncertain, while the saved recovery code still works", async () => {
    const user = await signup("provider-failure");
    mail.available = false;
    expectError(await api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers }), 503);
    expect(mail.send).not.toHaveBeenCalled();
    mail.available = true;
    mail.send.mockRejectedValueOnce(Errors.unavailable("The email request could not be confirmed."));
    expectError(await api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers }), 503);
    expect(await prisma.verification.count({ where: { identifier: accountEmailIdentifier("reset_password", user.email) } })).toBe(0);
    expectOk(await api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password: "Recovered-with-code!" } }));
  });

  it("verifies only the current account and never accepts a verification-purpose code for a password reset", async () => {
    const user = await signup("verify");
    const other = await signup("verify-other");
    const status = await api("GET", "account/email-verification", { cookie: user.cookie });
    expectOk(status);
    expect(status.data).toEqual({ userId: user.id, email: user.email, verified: false, available: true });
    expectError(await api("POST", "account/email-verification/request", { cookie: other.cookie, body: { expectedUserId: user.id }, headers: ip() }), 409);
    const requested = await api("POST", "account/email-verification/request", { cookie: user.cookie, body: { expectedUserId: user.id }, headers: user.headers });
    expectOk(requested, 202);
    const code = mail.send.mock.calls[0][0].code;
    expectError(await confirmReset(user, { challengeId: requested.data.challengeId, code }), 401);
    const body = { expectedUserId: user.id, challengeId: requested.data.challengeId, code };
    expectError(await api("POST", "account/email-verification/confirm", { cookie: other.cookie, body, headers: ip() }), 409);
    expectOk(await api("POST", "account/email-verification/confirm", { cookie: user.cookie, body, headers: user.headers }));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).emailVerified).toBe(false);
    expectError(await api("POST", "account/email-verification/confirm", { cookie: user.cookie, body, headers: user.headers }), 401);
  });

  it("revokes pending email proofs during recovery-code rotation and the central account deletion transition", async () => {
    const user = await signup("security-transitions");
    const challenge = await requestReset(user);
    expectOk(await api("POST", "account/recovery-code", { cookie: user.cookie, body: { password, expectedUserId: user.id } }));
    expectError(await confirmReset(user, challenge), 401);
    advancePastCooldown();
    const next = await requestReset(user);
    await prisma.$transaction((tx) => requestAccountDeletion(tx, { userId: user.id }));
    expect(await prisma.verification.findUnique({ where: { id: next.challengeId } })).toBeNull();
    expectError(await confirmReset(user, next), 401);
    expectError(await api("POST", "auth/login", { body: { email: user.email, password } }), 403, "forbidden");
  });

  it("does not spend the hourly mailbox ceiling on a request refused by the resend cooldown", async () => {
    const user = await signup("cooldown-allowance");
    const request = () => api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers });
    await requestReset(user);
    expectError(await request(), 429);
    for (let count = 1; count < 5; count++) {
      advancePastCooldown();
      await requestReset(user);
    }
    advancePastCooldown();
    expectError(await request(), 429);
  });

  it("persists the per-mailbox send ceiling independently of the requester IP", async () => {
    const user = await signup("send-limit");
    for (let count = 0; count < 5; count++) {
      if (count) advancePastCooldown();
      await requestReset({ ...user, headers: ip() });
    }
    advancePastCooldown();
    const sixth = await api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: ip() });
    expectError(sixth, 429);
    expect(mail.send).toHaveBeenCalledTimes(5);
    expect(sixth.error?.details.retryAfterMs).toBeGreaterThan(60_000);
  });

  it("does not grant a code authority before the provider acceptance receipt commits", async () => {
    const user = await signup("pending-delivery");
    let accept: () => void = () => {};
    mail.send.mockImplementationOnce(() => new Promise((resolve) => {
      accept = () => resolve({ provider: "resend", requestId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    }));
    const pending = api("POST", "auth/password-reset/request", { body: { email: user.email }, headers: user.headers });
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledOnce());
    const submitted = mail.send.mock.calls[0][0];
    try {
      const proof = JSON.parse((await prisma.verification.findUniqueOrThrow({ where: { id: submitted.challengeId } })).value);
      expect(proof.delivery).toBeNull();
      expectError(await confirmReset(user, submitted), 401);
    } finally { accept(); expectOk(await pending, 202); }
    expectOk(await confirmReset(user, submitted));
  });

  it("limits one requester across many different mailbox addresses before another email is submitted", async () => {
    const headers = ip();
    for (let count = 0; count < 20; count++) {
      await requestReset({ email: address(`ip-limit-${count}`), headers });
    }
    const blocked = await api("POST", "auth/password-reset/request", { body: { email: address("ip-limit-denied") }, headers });
    expectError(blocked, 429);
    expect(mail.send).toHaveBeenCalledTimes(20);
  });

  it("bounds expired email-record retention without deleting unrelated Better Auth or recovery authority", async () => {
    const expiredId = `account-email:proof:${"0".repeat(48)}`;
    const unrelatedId = `zt-email-unrelated-${runId}`;
    await prisma.verification.createMany({ data: [
      { id: expiredId, identifier: accountEmailIdentifier("reset_password", address("prune")), value: "expired-private-proof", expiresAt: new Date(0) },
      { id: unrelatedId, identifier: "existing-better-auth-identifier", value: "existing-authority", expiresAt: new Date(0) },
    ] });
    try {
      await requestReset({ email: address("prune-trigger"), headers: ip() });
      expect(await prisma.verification.findUnique({ where: { id: expiredId } })).toBeNull();
      expect(await prisma.verification.findUnique({ where: { id: unrelatedId } })).toMatchObject({ value: "existing-authority" });
    } finally { await prisma.verification.deleteMany({ where: { id: { in: [expiredId, unrelatedId] } } }); }
  });
});
