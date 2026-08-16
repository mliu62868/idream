import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELETE as deleteAnnouncementRoute,
  PATCH as patchAnnouncementRoute,
} from "@/app/api/v2/admin/announcements/[id]/route";
import {
  GET as listAnnouncementsRoute,
  POST as createAnnouncementRoute,
} from "@/app/api/v2/admin/announcements/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { api, createUser, expectOk, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2ann-";
const admin = { userId: `${P}admin`, role: "admin" };
const analyst = { userId: `${P}analyst`, role: "analyst" }; // growth.promo.read, no write
const ops = { userId: `${P}ops`, role: "ops" }; // no growth.promo.read

function createAnnouncement(actor: typeof admin, body: Record<string, unknown>) {
  return callAdminV2(createAnnouncementRoute, {
    url: "/api/v2/admin/announcements",
    method: "POST",
    actor,
    body,
  });
}

function listAnnouncements(actor: typeof admin) {
  return callAdminV2(listAnnouncementsRoute, {
    url: "/api/v2/admin/announcements",
    actor,
  });
}

describe("Admin v2 announcements", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
    await createUser({ id: ops.userId, role: "ops", dataClass: "internal" });
  });

  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: "announcements" } });
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("CRUD + public read filters active, with permission gating and audit", async () => {
    expect((await listAnnouncements(ops)).status).toBe(403);
    expect(
      (await createAnnouncement(analyst, {
        title: "x",
        body: "y",
        reason: "test promo",
        confirmation: "ANNOUNCE",
      })).status,
    ).toBe(403);

    expect(
      (await createAnnouncement(admin, {
        title: "Unsafe link",
        body: "bad protocol",
        href: "javascript:alert(1)",
        reason: "reject unsafe link",
        confirmation: "Unsafe link",
      })).status,
    ).toBe(400);
    expect(
      (await createAnnouncement(admin, {
        title: "Wrong confirmation",
        body: "should not create",
        reason: "reject wrong confirmation",
        confirmation: "ANNOUNCE",
      })).status,
    ).toBe(400);

    const created = expectAdminV2Ok(await createAnnouncement(admin, {
      title: "Launch sale",
      body: "50% off this week",
      href: "https://help.ourdream.ai/",
      level: "promo",
      active: true,
      reason: "promo launch",
      confirmation: "Launch sale",
    }));
    const id = created.data.announcement.id as string;

    expectAdminV2Ok(await listAnnouncements(analyst));

    // public read (no auth) includes the active one
    const pub = await api("GET", "announcements", {});
    expectOk(pub);
    expect(
      (pub.data.items as Array<{ id: string; href?: string }>).find((item) => item.id === id)?.href,
    ).toBe("https://help.ourdream.ai/");

    const patch = (body: Record<string, unknown>) =>
      callAdminV2(patchAnnouncementRoute, {
        url: `/api/v2/admin/announcements/${id}`,
        method: "PATCH",
        actor: admin,
        params: { id },
        body,
      });

    const wrongConfirmation = await patch({
      active: false,
      reason: "pause promo wrong",
      confirmation: "ANNOUNCE",
    });
    expect(wrongConfirmation.status).toBe(400);
    expect(wrongConfirmation.error?.code).toBe("bad_request");

    expectAdminV2Ok(await patch({ active: false, reason: "pause promo", confirmation: id }));
    const pub2 = await api("GET", "announcements", {});
    expect((pub2.data.items as Array<{ id: string }>).some((item) => item.id === id)).toBe(false);

    const remove = (body?: Record<string, unknown>) =>
      callAdminV2(deleteAnnouncementRoute, {
        url: `/api/v2/admin/announcements/${id}`,
        method: "DELETE",
        actor: admin,
        params: { id },
        body,
      });

    expect((await remove()).status).toBe(400);
    const wrongDeleteConfirmation = await remove({
      reason: "wrong delete confirmation",
      confirmation: "DELETE",
    });
    expect(wrongDeleteConfirmation.status).toBe(400);
    expect(wrongDeleteConfirmation.error?.code).toBe("bad_request");

    expectAdminV2Ok(await remove({ reason: "delete promo", confirmation: id }));
    const list = expectAdminV2Ok(await listAnnouncements(admin));
    expect((list.data.items as Array<{ id: string }>).some((item) => item.id === id)).toBe(false);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "growth.announcement.create", targetId: id },
    });
    expect(audit).not.toBeNull();
  });
});
