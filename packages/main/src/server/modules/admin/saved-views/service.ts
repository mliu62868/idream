import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { executeIdempotentDomainCommand } from "@/server/modules/admin/shared/domain-command";
import {
  actorWithPermission,
  jsonBody,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";

const savedViewCreateSchema = z.object({
  scope: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  filters: z.record(z.string(), z.unknown()).default({}),
});

export async function listSavedViews(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const scope = new URL(request.url).searchParams.get("scope") ?? undefined;
  const items = await prisma.adminSavedView.findMany({
    where: { ownerId: actor.id, scope },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return ok({ items });
}

export async function createSavedView(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const body = savedViewCreateSchema.parse(await jsonBody(request));
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "saved_view.create",
    targetType: "admin_saved_view",
    targetId: `${body.scope}:new`,
    payload: body,
    execute: async (tx) => {
      const view = await tx.adminSavedView.create({
        data: {
          ownerId: actor.id,
          scope: body.scope,
          label: body.label,
          filters: toInputJson(body.filters),
        },
      });
      return { view: savedViewResult(view) };
    },
  });
  return ok(result);
}

export async function deleteSavedView(request: Request, id: string) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const result = await executeIdempotentDomainCommand({
    request,
    actor,
    commandType: "saved_view.delete",
    targetType: "admin_saved_view",
    targetId: id,
    payload: { id },
    execute: async (tx) => {
      const deleted = await tx.adminSavedView.deleteMany({
        where: { id, ownerId: actor.id },
      });
      if (deleted.count === 0) throw Errors.notFound("Saved view not found");
      return { deleted: true, id };
    },
  });
  return ok(result);
}

function savedViewResult(view: {
  id: string;
  ownerId: string;
  scope: string;
  label: string;
  filters: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...view,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}
