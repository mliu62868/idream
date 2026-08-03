import { globalAdminSearchResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { effectiveCharacterIdsForPermission, effectivePermissions } from "@/server/admin/effective-permissions";
import { incidentReadScopeWhere } from "@/server/modules/admin-v2/incidents/scope";
import {
  operationalCharacterWhere,
  operationalContentProductionBatchWhere,
  operationalGenerationJobWhere,
  operationalUserWhere,
} from "@/server/modules/metric-data-scope";

export async function globalAdminSearch(request: Request) {
  const actor = await actorWithPermission(request, "dashboard.read");
  const query = queryParams(request, "GET /api/v2/admin/search");
  const permissions = await effectivePermissions(actor.id, actor.role);
  const characterScope = permissions.has("character.project.read")
    ? await effectiveCharacterIdsForPermission(actor.id, actor.role, "character.project.read")
    : new Set<string>();
  const contains = { contains: query.q, mode: "insensitive" as const };
  const incidentScope = permissions.has("ops.incident.read")
    ? await incidentReadScopeWhere(prisma, actor)
    : null;
  const [customers, characters, runs, cases, incidents, jobs] = await Promise.all([
    permissions.has("customer.read")
      ? prisma.user.findMany({ where: operationalUserWhere({ role: "user", OR: [{ id: contains }, { email: contains }, { displayName: contains }, { name: contains }] }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
    permissions.has("character.project.read") && (characterScope === null || characterScope.size > 0)
      ? prisma.character.findMany({ where: operationalCharacterWhere({ deletedAt: null, ...(characterScope === null ? {} : { id: { in: [...characterScope] } }), OR: [{ id: contains }, { name: contains }, { description: contains }] }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
    permissions.has("creative.run.read")
      ? prisma.contentProductionBatch.findMany({ where: operationalContentProductionBatchWhere({ OR: [{ id: contains }, { title: contains }, { targetId: contains }] }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
    permissions.has("case.read")
      ? prisma.adminCase.findMany({ where: { ...(actor.role === "support" ? { type: { in: ["support_request", "billing_dispute"] } } : {}), OR: [{ id: contains }, { targetId: contains }, { caseKey: contains }] }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
    incidentScope
      ? prisma.opsIncident.findMany({ where: { AND: [incidentScope, { OR: [{ id: contains }, { signature: contains }, { suspectedCause: contains }] }] }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
    permissions.has("generation.job.read")
      ? prisma.generationJob.findMany({ where: operationalGenerationJobWhere({ OR: [{ id: contains }, { userId: contains }, { errorCode: contains }, { profileId: contains }] }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: query.limit })
      : [],
  ]);
  const items = [
    ...customers.map((row) => ({ kind: "customer", id: row.id, title: row.displayName ?? row.name ?? row.email, subtitle: row.email, href: `/admin/customers?customer=${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
    ...characters.map((row) => ({ kind: "character", id: row.id, title: row.name, subtitle: row.description, href: `/admin/characters/${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
    ...runs.map((row) => ({ kind: "creative_run", id: row.id, title: row.title, subtitle: `${row.purpose} · ${row.targetId ?? "unscoped"}`, href: `/admin/creative/runs/${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
    ...cases.map((row) => ({ kind: "case", id: row.id, title: `${row.type} · ${row.caseKey}`, subtitle: row.targetId, href: `/admin/cases/${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
    ...incidents.map((row) => ({ kind: "incident", id: row.id, title: row.suspectedCause ?? row.signature, subtitle: row.signature, href: `/admin/ops/incidents/${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
    ...jobs.map((row) => ({ kind: "generation_job", id: row.id, title: `${row.mode} generation`, subtitle: `${row.userId} · ${row.errorCode ?? row.profileId ?? "no error"}`, href: `/admin/ops/jobs?job=${encodeURIComponent(row.id)}`, status: row.status, updatedAt: row.updatedAt.toISOString() })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, query.limit);
  return ok(globalAdminSearchResponseSchema.parse({ items, query: query.q, asOf: new Date().toISOString() }), { headers: { "Cache-Control": "no-store" } });
}
