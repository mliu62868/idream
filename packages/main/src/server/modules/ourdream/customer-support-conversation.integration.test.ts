import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { adminV2 } from "@/server/test/admin-v2-http";
import { prisma } from "@/server/lib/db";

const P = "zt-support-conversation-";
const CUSTOMER = `${P}customer`;
const ADMIN = `${P}admin`;
const OTHER = `${P}other`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
  await createUser({ id: OTHER, dataClass: "customer" });
});
afterAll(() => purgeTestData(P));

async function fileRequest() {
  const filed = await api("POST", "support/requests", {
    userId: CUSTOMER, ageGate: true,
    body: { category: "bug", subject: "Cannot save my image", description: "The generated image cannot be saved after refresh." },
  });
  expectOk(filed, 201);
  return filed.data.request.ticketId as string;
}

describe("customer support conversation", () => {
  it("delivers the operator's question and returns a customer's reply to the active queue", async () => {
    const ticketId = await fileRequest();
    const waiting = await adminV2("PATCH", `support/requests/${ticketId}`, {
      userId: ADMIN, role: "admin",
      body: { status: "waiting_on_user", customerMessage: "Which image failed to save?", reason: "Need reproduction details", confirmation: ticketId },
    });
    expectOk(waiting);
    const question = await api("GET", `support/requests/${ticketId}`, { userId: CUSTOMER });
    expectOk(question);
    expect(question.data.request).toMatchObject({ status: "waiting_on_user", canReply: true,
      messages: [{ author: "support", body: "Which image failed to save?" }] });

    const replied = await api("POST", `support/requests/${ticketId}/messages`, {
      userId: CUSTOMER,
      body: { messageId: crypto.randomUUID(), body: "It is image ABC in my gallery." },
    });
    expectOk(replied, 201);
    expect(replied.data.request).toMatchObject({ status: "open", messages: [
      { author: "support", body: "Which image failed to save?" },
      { author: "customer", body: "It is image ABC in my gallery." },
    ] });
    const queue = await adminV2("GET", "cases", {
      userId: ADMIN, role: "admin", query: { view: "all", status: "in_progress" },
    });
    expectOk(queue);
    expect(queue.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ caseKey: `ticket:${ticketId}`, status: "in_progress", messageCount: 2 })]));
    const item = queue.data.items.find((item: { caseKey: string }) => item.caseKey === `ticket:${ticketId}`);
    const detail = await adminV2("GET", `cases/${item.id}`, { userId: ADMIN, role: "admin" });
    expectOk(detail);
    expect(detail.data.activity).toEqual(expect.arrayContaining([expect.objectContaining({ action: "case.support_message.added", actorId: ADMIN, actorRole: "admin" })]));
  });

  it("lets support reply without changing the current workflow status and replays that reply once", async () => {
    const ticketId = await fileRequest();
    const command = {
      userId: ADMIN, role: "admin", idempotencyKey: crypto.randomUUID(),
      body: { customerMessage: "We are checking the failed download.", reason: "Acknowledge request", confirmation: ticketId },
    };
    expectOk(await adminV2("PATCH", `support/requests/${ticketId}`, command));
    expectOk(await adminV2("PATCH", `support/requests/${ticketId}`, command));
    const detail = await adminV2("GET", `support/requests/${ticketId}`, { userId: ADMIN, role: "admin" });
    expectOk(detail);
    expect(detail.data.request).toMatchObject({ status: "received", messages: [{ author: "support", body: "We are checking the failed download." }] });
    expect(detail.data.request.messages).toHaveLength(1);
  });

  it("persists one concurrent customer reply, rejects key reuse, and keeps accepted retries readable after resolution", async () => {
    const ticketId = await fileRequest();
    const input = { userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "The download shows error 502." } };
    const replies = await Promise.all([api("POST", `support/requests/${ticketId}/messages`, input), api("POST", `support/requests/${ticketId}/messages`, input)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 201]);
    expect(replies[1].data.request.messages).toHaveLength(1);
    expectError(await api("POST", `support/requests/${ticketId}/messages`, { ...input, body: { ...input.body, body: "Different content" } }), 409, "conflict");
    const resolved = await adminV2("PATCH", `support/requests/${ticketId}`, {
      userId: ADMIN, role: "admin", body: { status: "resolved", customerMessage: "Downloads work again. Please refresh your gallery.", resolutionNotes: "private provider incident: secret@internal.test", reason: "Verified recovery", confirmation: ticketId },
    });
    expectOk(resolved);
    const replay = await api("POST", `support/requests/${ticketId}/messages`, input);
    expectOk(replay);
    expect(replay.data).toMatchObject({ replayed: true, request: { status: "resolved", canReply: false } });
    expect(replay.data.request.messages).toHaveLength(2);
    expect(JSON.stringify(replay.data)).not.toContain("secret@internal.test");
    expectError(await api("POST", `support/requests/${ticketId}/messages`, { userId: CUSTOMER, body: { messageId: crypto.randomUUID(), body: "New reply after resolution" } }), 409, "conflict");
  });

  it("isolates ticket ownership and never treats old case evidence or internal notes as public replies", async () => {
    const ticketId = await fileRequest();
    const ticket = await prisma.supportRequest.findUniqueOrThrow({ where: { ticketId } });
    const intake = await prisma.caseEvidence.findFirstOrThrow({ where: { sourceType: "support_request", sourceId: ticket.id } });
    await prisma.caseEvidence.create({ data: { caseId: intake.caseId, sourceType: "support_message", sourceId: `${P}legacy`, snapshot: { description: "Legacy internal evidence must stay private" }, occurredAt: new Date() } });
    await prisma.supportRequest.update({ where: { id: ticket.id }, data: { resolutionNotes: "Private operator note" } });
    expectError(await api("GET", `support/requests/${ticketId}`, { userId: OTHER }), 404, "not_found");
    expectError(await api("POST", `support/requests/${ticketId}/messages`, { userId: OTHER, body: { messageId: crypto.randomUUID(), body: "Another user's reply" } }), 404, "not_found");
    const own = await api("GET", `support/requests/${ticketId}`, { userId: CUSTOMER });
    expectOk(own);
    expect(own.data.request.messages).toEqual([]);
    expect(JSON.stringify(own.data)).not.toMatch(/Legacy internal|Private operator|resolutionNotes|authorId/);
    expectError(await adminV2("GET", `support/requests/${ticketId}`, { userId: CUSTOMER, role: "user" }), 403, "forbidden");
  });

  it("closes only a resolved request and preserves the customer-facing resolution", async () => {
    const ticketId = await fileRequest();
    const close = { userId: ADMIN, role: "admin", body: { status: "closed", reason: "Close completed case", confirmation: ticketId } };
    expectError(await adminV2("PATCH", `support/requests/${ticketId}`, close), 409, "conflict");
    expectOk(await adminV2("PATCH", `support/requests/${ticketId}`, {
      userId: ADMIN, role: "admin", body: { status: "resolved", customerMessage: "Your download is ready.", reason: "Checked the download", confirmation: ticketId },
    }));
    expectOk(await adminV2("PATCH", `support/requests/${ticketId}`, close));
    const detail = await api("GET", `support/requests/${ticketId}`, { userId: CUSTOMER });
    expectOk(detail);
    expect(detail.data.request).toMatchObject({ status: "closed", canReply: false, messages: [{ body: "Your download is ready." }] });
  });
});
