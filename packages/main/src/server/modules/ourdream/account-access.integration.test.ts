import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { api, cookieHeader, expectError, expectOk } from "@/server/test/helpers";
import { accountDeletionSubjectHash } from "@/server/account-deletion-authority";
import { deletionReceipt, readDeletionReceipt, recoveryIdentifier } from "./account-access";

const prefix = "zt-account-access-";
const password = "Original-password-0905!";
const ids: string[] = [];
async function signup(suffix: string) {
  const email = `${prefix}${suffix}@customer.invalid`;
  const result = await api("POST", "auth/signup", { body: { email, password, name: "Account access test" } });
  expectOk(result);
  ids.push(result.data.user.id);
  return { ...result, email, id: result.data.user.id as string, code: result.data.recoveryCode as string, cookie: cookieHeader(result.setCookies) };
}

afterAll(async () => {
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.accountDeletion.deleteMany({ where: { subjectHash: { in: ids.map(accountDeletionSubjectHash) } } });
  await prisma.verification.deleteMany({ where: { identifier: { in: ids.map(recoveryIdentifier) } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("account recovery and signed-out deletion receipts", () => {
  it("stores only a recovery hash, consumes the code once, revokes sessions and establishes the correct new session", async () => {
    const user = await signup("recover");
    expect(user.code).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{8}){5}$/);
    const proof = await prisma.verification.findFirstOrThrow({ where: { identifier: recoveryIdentifier(user.id) } });
    expect(proof.value).not.toBe(user.code.replaceAll("-", ""));
    const recovered = await api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password: "New-password-0905!" } });
    expectOk(recovered);
    expect(recovered.data.recoveryCode).not.toBe(user.code);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    const oldMe = await api("GET", "me", { cookie: user.cookie });
    expect(oldMe.data.user).toBeNull();
    const newMe = await api("GET", "me", { cookie: cookieHeader(recovered.setCookies) });
    expect(newMe.data.user.id).toBe(user.id);
    expectError(await api("POST", "auth/login", { body: { email: user.email, password } }), 401);
    expectError(await api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password } }), 401);
  });

  it("rejects bad, expired and cross-account codes and requires current password plus matching viewer to rotate", async () => {
    const a = await signup("a");
    const b = await signup("b");
    expectError(await api("POST", "auth/recover", { body: { email: b.email, recoveryCode: a.code, password } }), 401);
    expectError(await api("POST", "account/recovery-code", { cookie: a.cookie, body: { password: "wrong-password", expectedUserId: a.id } }), 401);
    expectError(await api("POST", "account/recovery-code", { cookie: b.cookie, body: { password, expectedUserId: a.id } }), 409);
    await prisma.verification.updateMany({ where: { identifier: recoveryIdentifier(a.id) }, data: { expiresAt: new Date(0) } });
    expectError(await api("POST", "auth/recover", { body: { email: a.email, recoveryCode: a.code, password } }), 401);
    const rotated = await api("POST", "account/recovery-code", { cookie: a.cookie, body: { password, expectedUserId: a.id } });
    expectOk(rotated);
    expect(await prisma.verification.count({ where: { identifier: recoveryIdentifier(a.id) } })).toBe(1);
    expectOk(await api("POST", "auth/recover", { body: { email: a.email, recoveryCode: rotated.data.recoveryCode, password } }));
  });

  it("serializes two consumers of the same recovery proof so only one can reset the password", async () => {
    const user = await signup("race");
    const results = await Promise.all([
      api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password: "First-password-0905!" } }),
      api("POST", "auth/recover", { body: { email: user.email, recoveryCode: user.code, password: "Second-password-0905!" } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("requires password and DELETE, then keeps the pre-issued receipt usable after revocation and through final state", async () => {
    const user = await signup("deletion");
    const body = { password, expectedUserId: user.id, confirmation: "DELETE" };
    expectError(await api("POST", "account/delete-request", { cookie: user.cookie, body: { ...body, password: "incorrect" } }), 401);
    expectError(await api("POST", "account/delete-request", { cookie: user.cookie, body: { password, expectedUserId: user.id } }), 400);
    const prepared = await api("POST", "account/deletion-receipt", { cookie: user.cookie, body });
    expectOk(prepared);
    const headers = { authorization: `Bearer ${prepared.data.receipt}` };
    expect((await api("GET", "account/deletion-status", { headers })).data.deletion).toBeNull();
    const deleted = await api("POST", "account/delete-request", { cookie: user.cookie, body });
    expectOk(deleted);
    expect((await api("GET", "account/deletion-status", { headers })).data.deletion.status).toBe("awaiting_chat");
    expectError(await api("POST", "account/delete-request", { cookie: user.cookie, body }), 401);
    expect(await prisma.accountDeletion.count({ where: { userId: user.id } })).toBe(1);
    expectError(await api("GET", "account/deletion-status", { headers: { authorization: `Bearer ${prepared.data.receipt}x` } }), 401);
    expectError(await api("GET", "account/deletion-status"), 401);
    const row = await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: user.id } });
    await prisma.accountDeletion.update({ where: { id: row.id }, data: { lastError: { code: "account_deletion_generation_authority_pending" } } });
    expect((await api("GET", "account/deletion-status", { headers })).data.deletion.retrying).toBe(true);
    // Projection fixture only; real cross-service erasure is covered by
    // account-deletion-authority.integration.test.ts, not asserted here.
    await prisma.accountDeletion.update({ where: { id: row.id }, data: { status: "completed", completedAt: new Date(), lastError: Prisma.DbNull } });
    expect((await api("GET", "account/deletion-status", { headers })).data.deletion.status).toBe("completed");
  });

  it("expires and authenticates receipt tokens without granting other account access", () => {
    const id = `account_deletion_${"a".repeat(32)}`;
    const token = deletionReceipt(id, 1000);
    expect(readDeletionReceipt(token, 999)?.id).toBe(id);
    expect(readDeletionReceipt(token, 1000)).toBeNull();
    expect(readDeletionReceipt(`${token}.extra`, 999)).toBeNull();
    expect(readDeletionReceipt(token.replace(/^./, "x"), 999)).toBeNull();
  });
});
