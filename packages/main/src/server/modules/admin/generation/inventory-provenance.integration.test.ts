import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationJobListResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { globalAdminSearch } from "@/server/modules/admin-v2/search/global-search";
import {
  deadLetterQueue,
  listGenerationJobs,
} from "./dead-letter/service";
import { listGenerationJobsV2 } from "@/server/modules/admin-v2/jobs/query";

describe("Admin generation inventory data provenance", () => {
  const suffix = randomUUID();
  const token = `inventory-provenance-${suffix}`;
  const actorId = `${token}-admin`;
  const owners = {
    customer: `${token}-customer`,
    internal: `${token}-internal`,
    fixture: `${token}-fixture`,
    audit: `${token}-audit`,
  } as const;
  const jobIds = Object.fromEntries(
    Object.entries(owners).map(([dataClass]) => [
      dataClass,
      `${token}-job-${dataClass}`,
    ]),
  ) as Record<keyof typeof owners, string>;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `${actorId}@idream.internal`,
          role: "admin",
          status: "active",
          dataClass: "internal",
        },
        ...Object.entries(owners).map(([dataClass, id]) => ({
          id,
          email: `${id}@idream.test`,
          role: "user",
          status: "active",
          dataClass,
        })),
      ],
    });
    await prisma.generationJob.createMany({
      data: Object.entries(owners).map(([dataClass, userId]) => ({
        id: jobIds[dataClass as keyof typeof owners],
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        errorCode: token,
        sourceType: "inventory_provenance_test",
        sourceId: `${token}-source-${dataClass}`,
      })),
    });
  });

  afterAll(async () => {
    await prisma.generationJob.deleteMany({
      where: { id: { in: Object.values(jobIds) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, ...Object.values(owners)] } },
    });
    await prisma.$disconnect();
  });

  it("limits v2 and legacy Generation Jobs lists to customer and internal owners", async () => {
    const v2 = await call(
      listGenerationJobsV2,
      `/api/v2/admin/jobs?search=${token}&mode=all&limit=20`,
    );
    const v2Data = generationJobListResponseSchema.parse(v2);
    expect(scopeJobIds(v2Data.items)).toEqual(
      new Set([jobIds.customer, jobIds.internal]),
    );
    expect(v2Data.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal"],
      excludedDataClasses: ["fixture", "audit"],
    });

    const legacy = await call(
      listGenerationJobs,
      "/api/v1/admin/generation/jobs?mode=all&limit=100",
    );
    expect(scopeJobIds(legacy.items as Array<{ id: string }>)).toEqual(
      new Set([jobIds.customer, jobIds.internal]),
    );
    expect(legacy.dataScope).toEqual(v2Data.dataScope);
  });

  it("limits Dead-letter and Global Search generation jobs to the same operational scope", async () => {
    const deadLetter = await call(
      deadLetterQueue,
      `/api/v1/admin/generation/dead-letter?search=${token}&status=failed&limit=100`,
    );
    expect(scopeJobIds(deadLetter.items as Array<{ id: string }>)).toEqual(
      new Set([jobIds.customer, jobIds.internal]),
    );
    expect(deadLetter.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal"],
      excludedDataClasses: ["fixture", "audit"],
    });

    const search = await call(
      globalAdminSearch,
      `/api/v2/admin/search?q=${token}&limit=20`,
    );
    expect(scopeJobIds(
      (search.items as Array<{ kind: string; id: string }>).filter(
        (item) => item.kind === "generation_job",
      ),
    )).toEqual(new Set([jobIds.customer, jobIds.internal]));
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
    const response = await handle(() => handler(request))(request);
    expect(response.status).toBe(200);
    return (await response.json()).data as Record<string, unknown>;
  }

  function scopeJobIds(items: readonly { id: string }[]) {
    return new Set(
      items
        .map((item) => item.id)
        .filter((id) => id.startsWith(`${token}-job-`)),
    );
  }
});
