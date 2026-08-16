import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getCmsPageRoute } from "@/app/api/v2/admin/cms/page/route";
import {
  GET as listCmsPagesRoute,
  PATCH as patchCmsPageRoute,
  POST as createCmsPageRoute,
} from "@/app/api/v2/admin/cms/pages/route";
import { POST as publishCmsPageRoute } from "@/app/api/v2/admin/cms/pages/publish/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2cms-";
const path = `/${P}landing`;
const admin = { userId: `${P}admin`, role: "admin" };
const analyst = { userId: `${P}analyst`, role: "analyst" };

const completeBody = {
  heading: "AI Girlfriend Guide",
  intro:
    "This guide explains how to define a companion clearly, validate the draft, and publish only a complete experience.",
  sections: [
    {
      heading: "Define the companion",
      paragraphs: [
        "Start with a specific relationship promise, stable personality traits, and an opening message that sets expectations.",
      ],
    },
    {
      heading: "Validate before publishing",
      paragraphs: [
        "Review the complete draft and its public presentation so an incomplete or stale version never reaches customers.",
      ],
    },
  ],
};

function createPage(actor: typeof admin, body: Record<string, unknown>) {
  return callAdminV2(createCmsPageRoute, {
    url: "/api/v2/admin/cms/pages",
    method: "POST",
    actor,
    body,
  });
}

function patchPage(body: Record<string, unknown>) {
  return callAdminV2(patchCmsPageRoute, {
    url: "/api/v2/admin/cms/pages",
    method: "PATCH",
    actor: admin,
    body,
  });
}

function publishPage(body: Record<string, unknown>) {
  return callAdminV2(publishCmsPageRoute, {
    url: "/api/v2/admin/cms/pages/publish",
    method: "POST",
    actor: admin,
    body,
  });
}

describe("Admin v2 CMS pages", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await prisma.routePage.deleteMany({ where: { path: { startsWith: `/${P}` } } });
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
  });

  afterAll(async () => {
    await prisma.routePage.deleteMany({ where: { path: { startsWith: `/${P}` } } });
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("runs draft → publish → unpublish under CAS, typed confirmation, and permission gating", async () => {
    // analyst lacks content.cms.write
    expect(
      (await createPage(analyst, {
        path,
        title: "X",
        description: "d",
        reason: "denied write",
        confirmation: path,
      })).status,
    ).toBe(403);

    // typed confirmation must equal the page path
    expect(
      (await createPage(admin, {
        path,
        title: "AI Girlfriend Guide",
        description: "Everything about AI companions.",
        reason: "seed cms page",
        confirmation: "CMS",
      })).status,
    ).toBe(400);

    const created = expectAdminV2Ok(await createPage(admin, {
      path,
      title: "AI Girlfriend Guide",
      description:
        "A complete editorial guide to creating, reviewing, and publishing trustworthy AI companions.",
      body: completeBody,
      reason: "seed cms page",
      confirmation: path,
    }));
    expect(created.data.page).toMatchObject({
      contentStatus: "draft",
      contentSchemaVersion: null,
      publishedAt: null,
      editable: true,
      publishability: "ready",
    });
    const createdUpdatedAt = created.data.page.updatedAt as string;

    // create cannot smuggle a published status past the publication command
    expect(
      (await createPage(admin, {
        path: `/${P}direct-publish`,
        title: "Direct publish is forbidden",
        description:
          "A complete description that still cannot bypass the CMS draft publication authority.",
        contentStatus: "published",
        reason: "attempt direct publish",
        confirmation: `/${P}direct-publish`,
      })).status,
    ).toBe(400);

    expect(
      (await patchPage({
        path,
        title: "Y",
        expectedUpdatedAt: createdUpdatedAt,
        reason: "valid edit reason",
        confirmation: "CMS",
      })).status,
    ).toBe(400);

    const patched = expectAdminV2Ok(await patchPage({
      path,
      title: "AI Girlfriend Guide Updated",
      expectedUpdatedAt: createdUpdatedAt,
      reason: "valid edit reason",
      confirmation: path,
    }));
    expect(patched.data.page.title).toBe("AI Girlfriend Guide Updated");
    const patchedUpdatedAt = patched.data.page.updatedAt as string;

    // stale CAS on both the draft edit and the publication command
    expect(
      (await patchPage({
        path,
        title: "Stale overwrite",
        expectedUpdatedAt: createdUpdatedAt,
        reason: "stale edit attempt",
        confirmation: path,
      })).status,
    ).toBe(409);
    expect(
      (await publishPage({
        path,
        contentStatus: "published",
        expectedUpdatedAt: createdUpdatedAt,
        reason: "stale publish attempt",
        confirmation: path,
      })).status,
    ).toBe(409);
    expect(
      (await publishPage({
        path,
        contentStatus: "published",
        expectedUpdatedAt: patchedUpdatedAt,
        reason: "go live",
        confirmation: "PUBLISH",
      })).status,
    ).toBe(400);

    const published = expectAdminV2Ok(await publishPage({
      path,
      contentStatus: "published",
      expectedUpdatedAt: patchedUpdatedAt,
      reason: "go live",
      confirmation: path,
    }));
    expect(published.data.page).toMatchObject({
      contentStatus: "published",
      contentSchemaVersion: 1,
      editable: false,
    });
    expect(published.data.page.publishedAt).toBeTruthy();
    const publishedUpdatedAt = published.data.page.updatedAt as string;

    expect(
      (await patchPage({
        path,
        title: "Published pages cannot be edited",
        expectedUpdatedAt: publishedUpdatedAt,
        reason: "invalid published edit",
        confirmation: path,
      })).status,
    ).toBe(409);

    const got = expectAdminV2Ok(await callAdminV2(getCmsPageRoute, {
      url: "/api/v2/admin/cms/page",
      actor: admin,
      query: { path },
    }));
    expect(got.data.page.title).toBe("AI Girlfriend Guide Updated");
    expect(got.data.page.publishability).toBe("ready");
    expect(got.data.page.body).toMatchObject({ heading: "AI Girlfriend Guide" });

    const listed = expectAdminV2Ok(await callAdminV2(listCmsPagesRoute, {
      url: "/api/v2/admin/cms/pages",
      actor: admin,
      query: { q: `${P}landing` },
    }));
    expect(
      (listed.data.items as Array<{ path: string }>).some((item) => item.path === path),
    ).toBe(true);

    const unpublished = expectAdminV2Ok(await publishPage({
      path,
      contentStatus: "draft",
      expectedUpdatedAt: publishedUpdatedAt,
      reason: "return to draft",
      confirmation: path,
    }));
    expect(unpublished.data.page).toMatchObject({
      contentStatus: "draft",
      contentSchemaVersion: null,
      indexingStatus: "noindex",
      publishedAt: null,
      editable: true,
    });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "cms.page.publish", targetId: path },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a pathname that CMS does not own", async () => {
    const result = await createPage(admin, {
      path: "/admin/takeover",
      title: "Reserved route",
      description: "A reserved application route can never become CMS-owned content.",
      reason: "reserved route attempt",
      confirmation: "/admin/takeover",
    });
    expect(result.status).toBe(400);
  });
});
