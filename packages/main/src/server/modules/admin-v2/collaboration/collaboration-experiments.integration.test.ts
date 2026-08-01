import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { POST as createExperimentRoute } from "@/app/api/v2/admin/experiments/route";
import { POST as startExperimentRoute } from "@/app/api/v2/admin/experiments/[id]/commands/start/route";
import { GET as listActivityRoute, POST as activityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import { PUT as watchRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/watch/route";
import { GET as mentionsRoute } from "@/app/api/v2/admin/collaboration/mentions/route";
import { POST as createViewRoute } from "@/app/api/v2/admin/saved-views/route";
import { PATCH as patchViewRoute } from "@/app/api/v2/admin/saved-views/[id]/route";

describe("admin collaboration, saved views, and managed experiments", () => {
  const suffix = randomUUID();
  const adminId = `${suffix}-admin`;
  const analystId = `${suffix}-analyst`;
  const supportId = `${suffix}-support`;
  const reviewCaseId = `${suffix}-review-case`;
  const experimentKey = `managed-${suffix}`;
  let incidentId = "";
  const createdExperimentIds: string[] = [];

  const headers = (actorId = adminId, role = "admin", idempotencyKey?: string) => ({
    "content-type": "application/json",
    "x-idream-user-id": actorId,
    "x-idream-role": role,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  });

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
      { id: analystId, email: `${analystId}@example.test`, role: "analyst", status: "active" },
      { id: supportId, email: `${supportId}@example.test`, role: "support", status: "active" },
    ] });
    incidentId = (await prisma.opsIncident.create({ data: {
      signature: `collab-${suffix}`,
      signatureVersion: "v1",
      status: "triaged",
      severity: "high",
      ownerId: adminId,
      firstSeen: new Date(),
      lastSeen: new Date(),
      impact: {},
      mitigation: {},
    } })).id;
    await prisma.adminCase.create({
      data: {
        id: reviewCaseId,
        type: "content_report",
        targetType: "character",
        targetId: `${suffix}-target`,
        caseKey: `${suffix}-review`,
      },
    });
  });

  afterAll(async () => {
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: incidentId } });
    await prisma.operationalWorkPreference.deleteMany({ where: { sourceId: incidentId } });
    await prisma.adminSavedView.deleteMany({ where: { ownerId: adminId } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ targetId: incidentId }, { targetId: { in: createdExperimentIds } }] } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: incidentId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateType: "experiment_definition", aggregateId: { in: createdExperimentIds } } });
    await prisma.experimentDefinition.deleteMany({ where: { id: { in: createdExperimentIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.adminCase.deleteMany({ where: { id: reviewCaseId } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: analystId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, analystId, supportId] } } });
    await prisma.$disconnect();
  });

  it("persists personal server query state with idempotency and optimistic concurrency", async () => {
    const body = { scope: "incident", label: "High severity", queryState: { search: "provider", filters: { severity: "high" }, sort: { field: "updatedAt", direction: "desc" }, pageSize: 25 } };
    const make = () => new Request("http://localhost/api/v2/admin/saved-views", { method: "POST", headers: headers(adminId, "admin", `view-${suffix}`), body: JSON.stringify(body) });
    const first = await createViewRoute(make());
    const replay = await createViewRoute(make());
    expect(first.status).toBe(201);
    const replayPayload = await replay.json();
    expect(replayPayload).toMatchObject({ ok: true, data: { duplicate: true } });
    const view = (await first.json()).data.view as { id: string; version: number };
    const stale = await patchViewRoute(new Request(`http://localhost/api/v2/admin/saved-views/${view.id}`, { method: "PATCH", headers: { ...headers(), "if-match": '"99"' }, body: JSON.stringify({ expectedVersion: 99, label: "stale" }) }), { params: Promise.resolve({ id: view.id }) });
    expect(stale.status, await stale.clone().text()).toBe(409);
    const updated = await patchViewRoute(new Request(`http://localhost/api/v2/admin/saved-views/${view.id}`, { method: "PATCH", headers: { ...headers(), "if-match": `"${view.version}"` }, body: JSON.stringify({ expectedVersion: view.version, label: "High severity owned" }) }), { params: Promise.resolve({ id: view.id }) });
    expect(await updated.json()).toMatchObject({ ok: true, data: { view: { version: 2, label: "High severity owned" } } });
  });

  it("records comments, mentions, handoff/watch activity separately from immutable audit evidence", async () => {
    const context = { params: Promise.resolve({ targetType: "incident", targetId: incidentId }) };
    const request = (body: object) => new Request(`http://localhost/api/v2/admin/collaboration/incident/${incidentId}/activity`, { method: "POST", headers: headers(adminId, "admin", `activity-${suffix}`), body: JSON.stringify(body) });
    const activityBody = { kind: "handoff", expectedVersion: 1, body: "Take over provider recovery", mentionedIds: [supportId], metadata: { handoffToActorId: analystId, attachments: [{ id: `evidence-${suffix}`, label: "Provider recovery log", mimeType: "text/plain" }], checklistItems: [] } };
    const first = await activityRoute(request(activityBody), context);
    expect(first.status).toBe(201);
    expect(await first.clone().json()).toMatchObject({ data: { authority: { ownerId: analystId, version: 2 }, duplicate: false } });
    const replay = await activityRoute(request(activityBody), context);
    expect((await replay.json()).data.duplicate).toBe(true);
    const collision = await activityRoute(request({ kind: "comment", body: "changed", mentionedIds: [], metadata: {} }), context);
    expect(collision.status).toBe(409);
    const watch = await watchRoute(new Request(`http://localhost/api/v2/admin/collaboration/incident/${incidentId}/watch`, { method: "PUT", headers: headers(adminId, "admin", `watch-${suffix}`), body: JSON.stringify({ watching: true }) }), context);
    expect(await watch.json()).toMatchObject({ ok: true, data: { watching: true, duplicate: false } });
    const activityList = await listActivityRoute(new Request(`http://localhost/api/v2/admin/collaboration/incident/${incidentId}/activity`, { headers: headers() }), context);
    const activityPayload = await activityList.json();
    expect(activityPayload).toMatchObject({ ok: true, data: { watcherIds: [adminId] } });
    expect(activityPayload.data.items.find((item: { kind: string }) => item.kind === "handoff")).toMatchObject({ metadata: { handoffToActorId: analystId, attachments: [{ label: "Provider recovery log" }] } });
    const hiddenMentions = await mentionsRoute(new Request("http://localhost/api/v2/admin/collaboration/mentions", { headers: headers(analystId, "analyst") }));
    expect(await hiddenMentions.json()).toMatchObject({ ok: true, data: { items: [] } });
    const supportIncident = await listActivityRoute(
      new Request(`http://localhost/api/v2/admin/collaboration/incident/${incidentId}/activity`, { headers: headers(supportId, "support") }),
      context,
    );
    expect(supportIncident.status).toBe(403);
    const supportCase = await activityRoute(
      new Request(`http://localhost/api/v2/admin/collaboration/case/${reviewCaseId}/activity`, {
        method: "POST",
        headers: headers(supportId, "support", `support-case-${suffix}`),
        body: JSON.stringify({ kind: "comment", body: "Out-of-scope review case", mentionedIds: [], metadata: {} }),
      }),
      { params: Promise.resolve({ targetType: "case", targetId: reviewCaseId }) },
    );
    expect(supportCase.status).toBe(403);
    const supportMentions = await mentionsRoute(new Request("http://localhost/api/v2/admin/collaboration/mentions", { headers: headers(supportId, "support") }));
    expect(await supportMentions.json()).toMatchObject({ ok: true, data: { items: [] } });
    await prisma.adminUserPermission.create({ data: { userId: analystId, permissionKey: "ops.incident.read", effect: "grant", reason: "integration permission scope", createdById: adminId } });
    const visibleMentions = await mentionsRoute(new Request("http://localhost/api/v2/admin/collaboration/mentions", { headers: headers(analystId, "analyst") }));
    expect(await visibleMentions.json()).toMatchObject({ ok: true, data: { items: [{ targetId: incidentId, mentionedIds: [analystId, supportId] }] } });
    expect(await prisma.opsIncident.findUniqueOrThrow({ where: { id: incidentId } })).toMatchObject({ ownerId: analystId, version: 2 });
    expect(await prisma.adminAuditLog.count({ where: { targetId: incidentId, action: "collaboration.handoff" } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: incidentId, eventType: "admin.collaboration.handoff.v2" } })).toBe(1);
    expect(await prisma.adminCollaborationActivity.count({ where: { targetId: incidentId } })).toBe(2);
  });

  it("enforces experiment.manage, immutable versions, idempotency, and one running version under concurrency", async () => {
    const body = (hypothesis: string) => ({
      key: experimentKey,
      hypothesis,
      eligibility: { country: ["US"] },
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
      salt: `salt-${suffix}`,
      metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control", minimumMaturePerArm: 20, guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }] },
    });
    const forbidden = await createExperimentRoute(new Request("http://localhost/api/v2/admin/experiments", { method: "POST", headers: headers(analystId, "analyst", "forbidden"), body: JSON.stringify(body("Treatment improves qualified engagement")) }));
    expect(forbidden.status).toBe(403);
    const create = async (version: number) => createExperimentRoute(new Request("http://localhost/api/v2/admin/experiments", { method: "POST", headers: headers(adminId, "admin", `experiment-${suffix}-${version}`), body: JSON.stringify(body(`Treatment version ${version} improves qualified engagement`)) }));
    const [first, firstReplay] = await Promise.all([create(1), create(1)]);
    expect([first.status, firstReplay.status].sort()).toEqual([200, 201]);
    const second = await create(2);
    const firstData = (await first.json()).data.experiment as { id: string; version: number; stateVersion: number };
    expect((await firstReplay.json()).data.experiment.id).toBe(firstData.id);
    const secondData = (await second.json()).data.experiment as { id: string; version: number; stateVersion: number };
    createdExperimentIds.push(firstData.id, secondData.id);
    expect([firstData.version, secondData.version]).toEqual([1, 2]);
    const start = (item: typeof firstData, key: string) => startExperimentRoute(new Request(`http://localhost/api/v2/admin/experiments/${item.id}/commands/start`, { method: "POST", headers: headers(adminId, "admin", key), body: JSON.stringify({ expectedStateVersion: item.stateVersion, reason: "concurrency gate" }) }), { params: Promise.resolve({ id: item.id }) });
    const responses = await Promise.all([start(firstData, `start-${suffix}-1`), start(secondData, `start-${suffix}-2`)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await prisma.experimentDefinition.count({ where: { key: experimentKey, status: "running" } })).toBe(1);
  });
});
