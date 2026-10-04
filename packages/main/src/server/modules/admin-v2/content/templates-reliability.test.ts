import type { CharacterTemplate } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Receipt = { scope: string; idempotencyKey: string; requestHash: string; result: unknown };
type ReceiptWhere = { scope_idempotencyKey: { scope: string; idempotencyKey: string } };

// The fake preserves commit/rollback boundaries; the real route, request/response
// contracts, mutation executor and receipt hashing remain under test.
const db = vi.hoisted(() => {
  let rows = new Map<string, CharacterTemplate>();
  let receipts = new Map<string, Receipt>();
  let audits: unknown[] = [];
  let nextId = 0;
  let failAudit = false;
  const receiptKey = (where: ReceiptWhere) => `${where.scope_idempotencyKey.scope}:${where.scope_idempotencyKey.idempotencyKey}`;
  const client = (
    templates: Map<string, CharacterTemplate>,
    commands: Map<string, Receipt>,
    auditRows: unknown[],
  ) => ({
    $executeRaw: async () => 1,
    characterTemplate: {
      create: async ({ data }: { data: Omit<CharacterTemplate, "id" | "createdAt" | "updatedAt"> }) => {
        const row = { ...data, id: `template-${++nextId}`, createdAt: new Date(), updatedAt: new Date() };
        templates.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => templates.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = templates.get(where.id);
        if (!row) throw new Error("Missing template");
        return row;
      },
      updateMany: async ({ where, data }: { where: { id: string; updatedAt: Date }; data: Partial<CharacterTemplate> }) => {
        const current = templates.get(where.id);
        if (!current || current.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
        templates.set(current.id, { ...current, ...defined });
        return { count: 1 };
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: unknown }) => {
        if (failAudit) throw new Error("Injected audit write failure");
        auditRows.push(data);
        return data;
      },
    },
    controlPlaneCommand: {
      findUnique: async ({ where }: { where: ReceiptWhere }) => commands.get(receiptKey(where)) ?? null,
      create: async ({ data }: { data: Receipt }) => {
        commands.set(`${data.scope}:${data.idempotencyKey}`, data);
        return data;
      },
    },
  });
  return {
    prisma: {
      get characterTemplate() { return client(rows, receipts, audits).characterTemplate; },
      get adminAuditLog() { return client(rows, receipts, audits).adminAuditLog; },
      get controlPlaneCommand() { return client(rows, receipts, audits).controlPlaneCommand; },
      $transaction: async (run: (tx: ReturnType<typeof client>) => Promise<unknown>) => {
        const stagedRows = new Map(rows);
        const stagedReceipts = new Map(receipts);
        const stagedAudits = [...audits];
        const result = await run(client(stagedRows, stagedReceipts, stagedAudits));
        rows = stagedRows; receipts = stagedReceipts; audits = stagedAudits;
        return result;
      },
    },
    rows: () => rows,
    receipts: () => receipts,
    audits: () => audits,
    failAudit: (value: boolean) => { failAudit = value; },
    reset: () => { rows.clear(); receipts.clear(); audits.length = 0; nextId = 0; failAudit = false; },
  };
});

vi.mock("@/server/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/server/moderation/text-authority", () => ({ moderateText: async () => ({ status: "approved" }) }));
vi.mock("../shared/authority", async () => {
  const { requireExecutableAdminV2Contract } = await import("@idream/shared/admin");
  const actor = (request: Request) => ({ id: request.headers.get("x-test-actor") ?? "starter-reliability-admin", role: "admin" });
  return {
    actorWithPermission: async (request: Request) => actor(request),
    authenticatedAdminActor: async (request: Request) => actor(request),
    requireActorPermission: async (request: Request) => actor(request),
    jsonBody: async (request: Request, contract: string) => requireExecutableAdminV2Contract(contract).schema.parse(await request.json()),
  };
});
vi.mock("@/server/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const { POST: create } = await import("@/app/api/v2/admin/content/templates/route");
const { PATCH: update } = await import("@/app/api/v2/admin/content/templates/[id]/route");
const { POST: activate } = await import("@/app/api/v2/admin/content/templates/[id]/active/route");
const path = "/api/v2/admin/content/templates";
const body = { name: "Reliable starter", reason: "Create an operational starter" };

function request(method: string, pathname: string, payload: unknown, key?: string, actorId?: string) {
  return new Request(`http://admin.test${pathname}`, {
    method, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...(actorId ? { "x-test-actor": actorId } : {}) },
    body: JSON.stringify(payload),
  });
}

async function createStarter(key = "create-starter", payload = body) {
  const response = await create(request("POST", path, payload, key));
  const json = await response.json();
  return { response, json, id: json.data?.template.id as string | undefined };
}

describe("starter mutation reliability through its HTTP routes", () => {
  beforeEach(db.reset);

  it("replays the committed starter after its first response is lost", async () => {
    const first = await createStarter();
    const retry = await createStarter();
    expect(first.response.status).toBe(200);
    expect(retry.response.status).toBe(200);
    expect(retry.json).toEqual(first.json);
    expect(db.rows().size).toBe(1);
    expect(db.audits()).toHaveLength(1);
    expect(db.receipts().size).toBe(1);
  });

  it("rejects a different create payload reusing the same key", async () => {
    await createStarter();
    const result = await createStarter("create-starter", { ...body, name: "Different starter" });
    expect(result.response.status).toBe(409);
    expect(db.rows().size).toBe(1);
  });

  it("requires a key before creating a starter", async () => {
    const result = await create(request("POST", path, body));
    expect(result.status).toBe(400);
    expect(db.rows().size).toBe(0);
  });

  it("rolls back creation with its audit and lets the same key retry", async () => {
    db.failAudit(true);
    expect((await createStarter()).response.status).toBe(500);
    expect(db.rows().size).toBe(0);
    expect(db.receipts().size).toBe(0);
    db.failAudit(false);
    expect((await createStarter()).response.status).toBe(200);
    expect(db.rows().size).toBe(1);
  });

  it.each(["update", "active"] as const)("rolls back %s when its audit cannot be written", async (operation) => {
    const { id } = await createStarter();
    const prior = db.rows().get(id!)!;
    db.failAudit(true);
    const context = { params: Promise.resolve({ id: id! }) };
    const result = operation === "update"
      ? await update(request("PATCH", `${path}/${id}`, { expectedUpdatedAt: prior.updatedAt.toISOString(), name: "Changed starter", reason: "Edit the starter" }, "edit"), context)
      : await activate(request("POST", `${path}/${id}/active`, { expectedUpdatedAt: prior.updatedAt.toISOString(), active: true, confirmation: id, reason: "Publish the starter" }, "active"), context);
    expect(result.status).toBe(500);
    expect(db.rows().get(id!)).toEqual(prior);
    expect(db.audits()).toHaveLength(1);
    expect(db.receipts().size).toBe(1);
  });

  it.each(["update", "active"] as const)("replaying an earlier %s does not undo a newer command", async (operation) => {
    const { id } = await createStarter();
    const versions = new Map<string, string>();
    const call = async (name: string, active: boolean, key: string) => {
      const context = { params: Promise.resolve({ id: id! }) };
      const expectedUpdatedAt = versions.get(key) ?? db.rows().get(id!)!.updatedAt.toISOString();
      versions.set(key, expectedUpdatedAt);
      return operation === "update"
        ? update(request("PATCH", `${path}/${id}`, { expectedUpdatedAt, name, reason: "Edit the starter" }, key), context)
        : activate(request("POST", `${path}/${id}/active`, { expectedUpdatedAt, active, confirmation: id, reason: "Change publication" }, key), context);
    };
    const first = await (await call("First edit", true, "first")).json();
    expect((await call("Latest edit", false, "second")).status).toBe(200);
    const replay = await (await call("First edit", true, "first")).json();
    expect(replay).toEqual(first);
    expect(db.rows().get(id!)).toMatchObject(operation === "update" ? { name: "Latest edit" } : { isActive: false });
    expect(db.audits()).toHaveLength(3);
    expect(db.receipts().size).toBe(3);
  });

  it.each(["update", "active"] as const)("rejects another operator's stale %s after the starter changes", async (operation) => {
    const { id } = await createStarter();
    const expectedUpdatedAt = db.rows().get(id!)!.updatedAt.toISOString();
    const context = { params: Promise.resolve({ id: id! }) };
    const latest = await update(request("PATCH", `${path}/${id}`, {
      expectedUpdatedAt, name: "Operator B's current name", reason: "B updates the shared starter",
    }, "operator-b-update", "operator-b"), context);
    expect(latest.status).toBe(200);

    const stale = operation === "update"
      ? await update(request("PATCH", `${path}/${id}`, {
        expectedUpdatedAt, name: body.name, summary: "Operator A's stale form", reason: "A edits the old summary",
      }, "operator-a-update", "operator-a"), context)
      : await activate(request("POST", `${path}/${id}/active`, {
        expectedUpdatedAt, active: true, confirmation: id, reason: "A publishes the old snapshot",
      }, "operator-a-active", "operator-a"), context);
    expect(stale.status).toBe(409);
    expect(db.rows().get(id!)).toMatchObject({ name: "Operator B's current name", isActive: false });
    expect(db.audits()).toHaveLength(2);
  });

  it("advances the version for successive writes within the same clock millisecond", async () => {
    const { id } = await createStarter();
    const initial = db.rows().get(id!)!.updatedAt.getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
    const context = { params: Promise.resolve({ id: id! }) };
    try {
      for (const step of [1, 2]) {
        const result = await update(request("PATCH", `${path}/${id}`, {
          expectedUpdatedAt: new Date(initial + step - 1).toISOString(), name: `Edit ${step}`, reason: "Successive edit",
        }, `same-millisecond-${step}`), context);
        expect(result.status).toBe(200);
        expect(db.rows().get(id!)!.updatedAt.getTime()).toBe(initial + step);
      }
      const stale = await update(request("PATCH", `${path}/${id}`, {
        expectedUpdatedAt: new Date(initial).toISOString(), name: "Old snapshot", reason: "Stale edit",
      }, "stale-millisecond"), context);
      expect(stale.status).toBe(409);
      expect(db.rows().get(id!)!.name).toBe("Edit 2");
    } finally {
      clock.mockRestore();
    }
  });
});
