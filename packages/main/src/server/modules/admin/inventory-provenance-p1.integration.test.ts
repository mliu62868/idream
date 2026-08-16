import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { GET as listContentCharacters } from "@/app/api/v2/admin/content/characters/route";
import { GET as getFeaturedCharacters } from "@/app/api/v2/admin/content/featured/route";
import { moderationQueue } from "@/server/modules/admin/moderation/service";
import { listSupportRequests } from "@/server/modules/admin/support/service";

describe("Admin P1 inventory provenance", () => {
  const suffix = randomUUID();
  const token = `p1-provenance-${suffix}`;
  const actorId = `${token}-admin`;
  const owners = {
    customer: `${token}-customer`,
    internal: `${token}-internal`,
    fixture: `${token}-fixture`,
    audit: `${token}-audit`,
  } as const;
  const dataClasses = Object.keys(owners) as Array<keyof typeof owners>;
  const reportIds = Object.fromEntries(
    dataClasses.map((dataClass) => [
      dataClass,
      `${token}-report-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;
  const mediaIds = Object.fromEntries(
    dataClasses.map((dataClass) => [
      dataClass,
      `${token}-media-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;
  const appealIds = Object.fromEntries(
    dataClasses.map((dataClass) => [
      dataClass,
      `${token}-appeal-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;
  const supportIds = Object.fromEntries(
    dataClasses.map((dataClass) => [
      dataClass,
      `${token}-support-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;
  const characterIds = Object.fromEntries(
    dataClasses.map((dataClass) => [
      dataClass,
      `${token}-character-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;
  const systemReportId = `${token}-report-system`;
  const officialCharacterId = `${token}-character-official`;
  let previousFeatured: {
    key: string;
    value: Prisma.AppSettingCreateInput["value"];
    version: number;
    status: string;
  } | null = null;

  beforeAll(async () => {
    const featuredSetting = await prisma.appSetting.findUnique({
      where: { key: "feed.featured" },
    });
    previousFeatured = featuredSetting
      ? {
          key: featuredSetting.key,
          value: appSettingJsonInput(featuredSetting.value),
          version: featuredSetting.version,
          status: featuredSetting.status,
        }
      : null;
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `${actorId}@idream.internal`,
          role: "admin",
          status: "active",
          dataClass: "internal",
        },
        ...dataClasses.map((dataClass) => ({
          id: owners[dataClass],
          email: `${owners[dataClass]}@idream.test`,
          role: "user",
          status: "active",
          dataClass,
        })),
      ],
    });
    await prisma.contentReport.createMany({
      data: [
        ...dataClasses.map((dataClass) => ({
          id: reportIds[dataClass],
          reporterId: owners[dataClass],
          targetType: "character",
          targetId: `${token}-target-${dataClass}`,
          category: "other_prohibited_content",
          description: token,
          status: "open",
        })),
        {
          id: systemReportId,
          reporterId: null,
          targetType: "system_signal",
          targetId: `${token}-system-target`,
          category: "system_detection",
          description: token,
          status: "open",
        },
      ],
    });
    await prisma.mediaAsset.createMany({
      data: dataClasses.map((dataClass) => ({
        id: mediaIds[dataClass],
        ownerId: owners[dataClass],
        type: "image",
        url: `memory://${mediaIds[dataClass]}`,
        safetyStatus: "blocked",
        metadata: {},
      })),
    });
    await prisma.appeal.createMany({
      data: dataClasses.map((dataClass) => ({
        id: appealIds[dataClass],
        userId: owners[dataClass],
        targetType: "character",
        targetId: `${token}-appeal-target-${dataClass}`,
        appealText: token,
        status: "open",
      })),
    });
    await prisma.supportRequest.createMany({
      data: dataClasses.map((dataClass) => ({
        id: supportIds[dataClass],
        ticketId: `${token}-ticket-${dataClass}`,
        userId: owners[dataClass],
        category: "generation",
        subject: token,
        description: `${token} support request`,
        status: "open",
      })),
    });
    await prisma.character.createMany({
      data: [
        ...dataClasses.map((dataClass) => ({
          id: characterIds[dataClass],
          creatorId: owners[dataClass],
          name: `${token} ${dataClass}`,
          age: 24,
          description: token,
          source: "user",
          visibility: "public",
          status: "approved",
          appearance: {},
          advancedDetails: {},
        })),
        {
          id: officialCharacterId,
          creatorId: null,
          name: `${token} official`,
          age: 24,
          description: token,
          source: "official",
          visibility: "public",
          status: "approved",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    await prisma.appSetting.upsert({
      where: { key: "feed.featured" },
      update: {
        value: {
          characterIds: [
            ...dataClasses.map((dataClass) => characterIds[dataClass]),
            officialCharacterId,
          ],
        },
      },
      create: {
        key: "feed.featured",
        value: {
          characterIds: [
            ...dataClasses.map((dataClass) => characterIds[dataClass]),
            officialCharacterId,
          ],
        },
      },
    });
  });

  afterAll(async () => {
    if (previousFeatured) {
      await prisma.appSetting.upsert({
        where: { key: previousFeatured.key },
        update: {
          value: previousFeatured.value,
          version: previousFeatured.version,
          status: previousFeatured.status,
        },
        create: {
          key: previousFeatured.key,
          value: previousFeatured.value,
          version: previousFeatured.version,
          status: previousFeatured.status,
        },
      });
    } else {
      await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
    }
    await prisma.supportRequest.deleteMany({
      where: { id: { in: Object.values(supportIds) } },
    });
    await prisma.appeal.deleteMany({
      where: { id: { in: Object.values(appealIds) } },
    });
    await prisma.contentReport.deleteMany({
      where: { id: { in: [...Object.values(reportIds), systemReportId] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: Object.values(mediaIds) } },
    });
    await prisma.character.deleteMany({
      where: {
        id: { in: [...Object.values(characterIds), officialCharacterId] },
      },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, ...Object.values(owners)] } },
    });
    await prisma.$disconnect();
  });

  it("filters moderation queues while retaining system-origin reports", async () => {
    const data = await call(
      moderationQueue,
      `/api/v1/admin/moderation/queue?search=${token}&limit=100`,
    );
    expect(ids(data.reports)).toEqual(
      new Set([reportIds.customer, reportIds.internal, systemReportId]),
    );
    expect(ids(data.blockedMedia)).toEqual(
      new Set([mediaIds.customer, mediaIds.internal]),
    );
    expect(ids(data.appeals)).toEqual(
      new Set([appealIds.customer, appealIds.internal]),
    );
  });

  it("filters support requests by requester provenance", async () => {
    const data = await call(
      listSupportRequests,
      `/api/v1/admin/support/requests?search=${token}&limit=100`,
    );
    expect(ids(data.items)).toEqual(
      new Set([supportIds.customer, supportIds.internal]),
    );
  });

  it("filters content inventory while exposing configured and effective Featured truth separately", async () => {
    const content = await call(
      listContentCharacters,
      `/api/v2/admin/content/characters?search=${token}&limit=100`,
    );
    expect(ids(content.items)).toEqual(
      new Set([
        characterIds.customer,
        characterIds.internal,
        officialCharacterId,
      ]),
    );

    const featured = await call(
      getFeaturedCharacters,
      "/api/v2/admin/content/featured",
    );
    const configuredIds = strings(featured.configuredCharacterIds);
    expect(new Set(configuredIds)).toEqual(
      new Set([...Object.values(characterIds), officialCharacterId]),
    );
    expect(ids(featured.items)).toEqual(new Set(configuredIds));
    expect(strings(featured.effectiveCharacterIds)).toEqual([]);
  });

  async function call(
    handler: (request: Request) => Promise<Response>,
    path: string,
  ) {
    const request = new Request(`http://localhost${path}`, {
      headers: {
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
      },
    });
    const response = await handler(request);
    expect(response.status).toBe(200);
    return (await response.json()).data as Record<string, unknown>;
  }

  function ids(value: unknown) {
    return new Set(
      Array.isArray(value)
        ? value
            .map((item) =>
              typeof item === "object" &&
              item !== null &&
              "id" in item &&
              typeof item.id === "string"
                ? item.id
                : null,
            )
            .filter((id): id is string => id !== null)
        : [],
    );
  }

  function strings(value: unknown) {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }
});

function appSettingJsonInput(
  value: Prisma.JsonValue,
): Prisma.AppSettingCreateInput["value"] {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
