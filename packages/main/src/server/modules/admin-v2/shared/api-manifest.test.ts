import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMAND_TARGET_READ_PERMISSIONS,
  ADMIN_V2_API_OPERATIONS,
  findAdminV2ApiOperation,
  resolveAdminV2ManifestAuthorization,
  type AdminV2ApiOperation,
} from "@idream/shared/admin/api-manifest";
import {
  ADMIN_V2_MUTATION_TRANSPORT,
  type AdminV2MutationTransport,
} from "@idream/shared/admin";
import { isPermissionKey } from "@/server/admin/permissions";

const HTTP_METHOD_PATTERN = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const routeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../app/api/v2/admin",
);

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  }));
  return nested.flat().sort();
}

function routePattern(file: string): string {
  const suffix = relative(routeRoot, dirname(file))
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.replace(/^\[([^\]]+)\]$/, ":$1"))
    .join("/");
  return `/api/v2/admin${suffix ? `/${suffix}` : ""}`;
}

function routeFile(operation: AdminV2ApiOperation) {
  const suffix = operation.route
    .replace(/^\/api\/v2\/admin\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.startsWith(":") ? `[${segment.slice(1)}]` : segment);
  return join(routeRoot, ...suffix, "route.ts");
}

function declaredRequirements(operation: AdminV2ApiOperation) {
  return operation.contract.request
    .split("+")
    .filter((part): part is "idempotency-key" | "if-match" =>
      part === "idempotency-key" || part === "if-match"
    )
    .sort();
}

function registryRequirements(transport: AdminV2MutationTransport) {
  if (transport.status === "pending") return [transport.requiredTransport.toLowerCase()];
  if (transport.kind === "idempotency_key") return ["idempotency-key"];
  if (transport.kind === "if_match") return ["if-match"];
  return ["idempotency-key", "if-match"];
}

function handlerRequirements(source: string) {
  return [
    ...(source.includes("requireIdempotencyKey(") ? ["idempotency-key"] : []),
    ...(source.includes("requireMatchingProjectVersion(") ||
      /headers\.get\(["']if-match["']\)/.test(source)
      ? ["if-match"]
      : []),
  ].sort();
}

async function implementedOperations(): Promise<string[]> {
  const operations: string[] = [];
  for (const file of await routeFiles(routeRoot)) {
    const source = await readFile(file, "utf8");
    const methods = [...source.matchAll(HTTP_METHOD_PATTERN)].map((match) => match[1]);
    for (const method of methods) operations.push(`${method} ${routePattern(file)}`);
  }
  return operations.sort();
}

function permissionKeys(operation: AdminV2ApiOperation): readonly string[] {
  if (operation.authorization.kind === "bootstrap") return [];
  if (operation.authorization.kind === "all_of") return operation.authorization.permissions;
  if (operation.authorization.kind === "one_of_by_resource") {
    return operation.authorization.permissions;
  }
  return [
    ...operation.authorization.always,
    ...operation.authorization.oneOf,
  ];
}

describe("Admin v2 API permission and contract manifest", () => {
  it("enumerates every implemented route method exactly once", async () => {
    const implemented = await implementedOperations();
    const declared = ADMIN_V2_API_OPERATIONS.map((operation) => operation.id).sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(implemented);
    expect(declared).toHaveLength(103);
  });

  it("fails closed unless each operation has typed authority and request/response contracts", () => {
    const bootstrap = ADMIN_V2_API_OPERATIONS.filter(
      (operation) => operation.authorization.kind === "bootstrap",
    );
    expect(bootstrap.map((operation) => operation.id)).toEqual([
      "GET /api/v2/admin/bootstrap",
    ]);

    for (const operation of ADMIN_V2_API_OPERATIONS) {
      expect(operation.contract.request).toBeTruthy();
      expect(operation.contract.response).toBeTruthy();
      if (operation.authorization.kind === "bootstrap") continue;

      const permissions = permissionKeys(operation);
      expect(permissions.length, operation.id).toBeGreaterThan(0);
      expect(new Set(permissions).size, operation.id).toBe(permissions.length);
      for (const permission of permissions) {
        expect(isPermissionKey(permission), `${operation.id}: ${permission}`).toBe(true);
      }
      for (const permission of operation.responseProjectionBy ?? []) {
        expect(isPermissionKey(permission), `${operation.id} projection: ${permission}`).toBe(true);
      }
      if (operation.authorization.kind === "one_of_by_resource") {
        expect(operation.authorization.resolver, operation.id).toBeTruthy();
      }
      if (operation.authorization.kind === "all_of_and_one_of_by_resource") {
        expect(operation.authorization.resolver, operation.id).toBeTruthy();
      }
    }
  });

  it("matches concrete deep-link paths without treating parameters as blanket wildcards", () => {
    expect(findAdminV2ApiOperation("GET", "/api/v2/admin/cases/case-17")?.id).toBe(
      "GET /api/v2/admin/cases/:id",
    );
    expect(findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/characters/char-1/releases/release-2/commands/publish",
    )?.authorization).toEqual({
      kind: "all_of",
      permissions: ["character.release.publish"],
    });
    expect(findAdminV2ApiOperation("GET", "/api/v2/admin/cases/case-17/unknown")).toBeNull();
    expect(findAdminV2ApiOperation("POST", "/api/v2/admin/cases/case-17")).toBeNull();
  });

  it("binds the permission checked by a handler to the exact method policy", () => {
    const attach = findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/creative/runs/run-1/commands/attach-incident",
    );
    expect(attach).not.toBeNull();
    expect(resolveAdminV2ManifestAuthorization(attach!, "ops.incident.manage")).toEqual([
      "ops.incident.manage",
      "creative.run.write",
    ]);
    expect(resolveAdminV2ManifestAuthorization(attach!, "dashboard.read")).toBeNull();

    const activity = findAdminV2ApiOperation(
      "GET",
      "/api/v2/admin/collaboration/creative_run/run-1/activity",
    );
    expect(resolveAdminV2ManifestAuthorization(activity!, "creative.run.read")).toEqual([
      "creative.run.read",
    ]);
    expect(resolveAdminV2ManifestAuthorization(activity!, "creative.run.write")).toBeNull();

    const command = findAdminV2ApiOperation("GET", "/api/v2/admin/commands/cmd-1");
    expect(resolveAdminV2ManifestAuthorization(command!, "dashboard.read")).toEqual([
      "dashboard.read",
    ]);
    expect(resolveAdminV2ManifestAuthorization(command!, "case.read")).toEqual([
      "dashboard.read",
      "case.read",
    ]);
    expect(command?.authorization).toMatchObject({
      kind: "all_of_and_one_of_by_resource",
      oneOf: expect.arrayContaining([...new Set(Object.values(ADMIN_COMMAND_TARGET_READ_PERMISSIONS))]),
    });

    const receiptRecovery = findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/mutation-receipts/reconcile",
    );
    expect(resolveAdminV2ManifestAuthorization(
      receiptRecovery!,
      "creative.run.review",
    )).toEqual(["creative.run.review"]);
    expect(resolveAdminV2ManifestAuthorization(
      receiptRecovery!,
      "character.project.write",
    )).toEqual(["character.project.write"]);
    expect(resolveAdminV2ManifestAuthorization(
      receiptRecovery!,
      "dashboard.read",
    )).toBeNull();
  });

  it("keeps every combined transport exact across manifest, registry, and handlers", async () => {
    const operationIds = (
      Object.keys(ADMIN_V2_MUTATION_TRANSPORT) as Array<
        keyof typeof ADMIN_V2_MUTATION_TRANSPORT
      >
    )
      .filter((operationId) => {
        const transport = ADMIN_V2_MUTATION_TRANSPORT[operationId];
        return transport?.status === "implemented" &&
          transport.kind === "idempotency_key_and_if_match";
      })
      .sort();

    for (const operationId of operationIds) {
      const operation = ADMIN_V2_API_OPERATIONS.find(({ id }) => id === operationId);
      const transport = (
        ADMIN_V2_MUTATION_TRANSPORT as Readonly<
          Record<string, AdminV2MutationTransport | undefined>
        >
      )[operationId];
      expect(operation, operationId).toBeDefined();
      expect(transport, operationId).toBeDefined();
      if (!operation || !transport) continue;

      const source = await readFile(routeFile(operation), "utf8");
      const handler = source.includes("executeAdminMutation")
        ? declaredRequirements(operation)
        : handlerRequirements(source);
      expect(handler, `${operationId} handler`).toEqual(["idempotency-key", "if-match"]);
      expect(declaredRequirements(operation), `${operationId} manifest`).toEqual(handler);
      expect(registryRequirements(transport).sort(), `${operationId} registry`).toEqual(handler);
    }
  });
});
