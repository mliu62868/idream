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
/** `someSchema.parse(await jsonBody(...))` — a handler re-narrowing the parsed body. */
const LOCAL_BODY_PARSE = /[A-Za-z0-9_]+\s*\.\s*parse\(\s*await\s+jsonBody\(/;
/** `jsonBody(request)` with no contract — the untyped door kept for legacy `/api/admin`. */
const UNDECLARED_BODY_READ = /jsonBody\(\s*request\s*\)/;
/** `someSchema.parse(Object.fromEntries(<url>.searchParams))` — a hand-rolled query door. */
const LOCAL_QUERY_PARSE = /\.\s*parse\(\s*Object\.fromEntries\([^;]*searchParams/;
/** Any manifest-shaped contract ref literal, wherever it appears in the file. */
const CONTRACT_REF_LITERAL = /"([A-Za-z0-9_]+Schema(?:\+[a-z-]+)*)"/g;
/** Any manifest-shaped operation id literal, quoted or templated. */
const OPERATION_ID_LITERAL = /["`]((?:GET|POST|PUT|PATCH|DELETE) \/api\/v2\/admin\/[^"`]*)["`]/g;
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const routeRoot = join(srcRoot, "app/api/v2/admin");
const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * SPEC: the single file allowed to turn a URL into a parsed Admin query.
 * INTENT: `queryParams` has to read `searchParams` somewhere. Naming the one file here means a
 * second query door cannot appear anywhere else without this guard saying so.
 */
const QUERY_DOOR = "shared/authority.ts";

/**
 * SPEC: modules that still parse their own HTTP body instead of naming their operation id,
 * with the operation each one is stuck on. Empty is the goal.
 * INTENT: an entry is a recorded debt, not a licence. The guard fails both ways — a new
 * hand-parse cannot hide behind an old entry, and an entry that no longer offends must be
 * deleted rather than left to rot.
 */
const MODULE_BODY_PARSE_DEBT: ReadonlyMap<string, string> = new Map([
  // The console sends the version in the body only, so demanding If-Match here would 400
  // every Saved View rename. See the SPEC note on `updateSavedViewV2`.
  ["collaboration/service.ts", "PATCH /api/v2/admin/saved-views/:id"],
]);

/**
 * SPEC: modules allowed to hold a request contract schema as a symbol, and the operation
 * whose body arrives in a shape `jsonBody` cannot parse.
 * INTENT: `multipart/form-data` has no JSON body, so these two are the *first* parse of
 * their operation's contract, not a second one. Every other module must take an
 * already-parsed body, or the manifest stops being the only place a request shape lives.
 */
const MODULE_FORM_CONTRACT_PARSERS: ReadonlyMap<string, string> = new Map([
  ["characters/image-sources.ts", "POST /api/v2/admin/characters/:id/image-sources"],
  ["characters/voice-identity.ts", "POST /api/v2/admin/characters/:id/voice-clones"],
]);

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  }));
  return nested.flat().sort();
}

async function moduleFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(path);
    const shipped = entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.includes(".test.");
    return shipped ? [path] : [];
  }));
  return nested.flat().sort();
}

/**
 * SPEC: every schema an inbound Admin request may be narrowed with — write bodies and read
 * queries alike.
 * INTENT: the two halves used to be one ban list and one blind spot: GET refs were filtered out,
 * so seventeen read operations kept their contract as a hand-imported symbol that nothing
 * reconciled with the manifest. `jsonBody` and `queryParams` now cover both halves, so the ban
 * list covers both halves too.
 */
function manifestRequestContractSymbols(): ReadonlySet<string> {
  return new Set(
    ADMIN_V2_API_OPERATIONS
      .map((operation) => operation.contract.request.split("+")[0]!)
      .filter((ref) => ref.endsWith("Schema")),
  );
}

/** SPEC: read operations whose contract lives in the URL — the half `queryParams` answers. */
function manifestQueryOperations() {
  return ADMIN_V2_API_OPERATIONS.filter(
    (operation) => operation.method === "GET" && operation.contract.request.endsWith("Schema"),
  );
}

/** `POST /api/v2/admin/x/${action}` must match at least one id the placeholder can stand for. */
function namesADeclaredOperation(literal: string, declaredIds: ReadonlySet<string>): boolean {
  if (declaredIds.has(literal)) return true;
  if (!literal.includes("${")) return false;
  const pattern = new RegExp(`^${literal
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[A-Za-z0-9_-]+")}$`);
  return [...declaredIds].some((id) => pattern.test(id));
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

  it("keeps the request contract inside the manifest, never in a Route Handler", async () => {
    const files = await routeFiles(routeRoot);
    // Self-check: a scan that loses the route tree must fail loudly, not pass empty.
    expect(files).toHaveLength(
      new Set(ADMIN_V2_API_OPERATIONS.map((operation) => operation.route)).size,
    );

    // Derived from the manifest, so a new operation joins the ban list on its own.
    const requestContractSymbols = manifestRequestContractSymbols();
    expect(requestContractSymbols.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    let filesNamingAContract = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const label = relative(routeRoot, file);
      const declaredRefs = new Set<string>(
        ADMIN_V2_API_OPERATIONS
          .filter((operation) => operation.route === routePattern(file))
          .map((operation) => operation.contract.request),
      );

      // INVARIANT: a request contract is named by ref, never imported as a symbol —
      // an imported schema is a second authority that nothing reconciles with the manifest.
      const imports = (source.match(/^import[\s\S]*?;$/gm) ?? []).join("\n");
      for (const symbol of requestContractSymbols) {
        if (new RegExp(`\\b${symbol}\\b`).test(imports)) {
          offenders.push(`${label}: imports request contract ${symbol}`);
        }
      }
      if (LOCAL_BODY_PARSE.test(source)) {
        offenders.push(`${label}: re-parses the body jsonBody already parsed`);
      }
      if (UNDECLARED_BODY_READ.test(source)) {
        offenders.push(`${label}: reads jsonBody without naming a contract ref`);
      }
      if (LOCAL_QUERY_PARSE.test(source)) {
        offenders.push(`${label}: parses the query itself instead of naming its operation`);
      }

      const refs = [...source.matchAll(CONTRACT_REF_LITERAL)].map((match) => match[1]!);
      if (refs.length > 0) filesNamingAContract += 1;
      for (const ref of refs) {
        if (!declaredRefs.has(ref)) {
          offenders.push(
            `${label}: names ${ref}; manifest declares ${[...declaredRefs].join(" | ") || "none"}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
    // Self-check: an assertion that inspected no contract ref is not a guard.
    expect(filesNamingAContract).toBeGreaterThan(0);
  });

  it("keeps the request contract inside the manifest, never in an Admin v2 module", async () => {
    const files = await moduleFiles(moduleRoot);
    // Self-check: a scan that loses the module tree must fail loudly, not pass empty.
    expect(files.length).toBeGreaterThan(50);

    const requestContractSymbols = manifestRequestContractSymbols();
    const declaredRefs = new Set<string>(
      ADMIN_V2_API_OPERATIONS.map((operation) => operation.contract.request),
    );
    const declaredIds = new Set<string>(
      ADMIN_V2_API_OPERATIONS.map((operation) => operation.id),
    );

    const offenders: string[] = [];
    const settledDebt: string[] = [];
    const exercisedFormExemptions = new Set<string>();
    const queryDoors: string[] = [];
    let filesNamingAnOperation = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const label = relative(moduleRoot, file).split(sep).join("/");
      const owed = MODULE_BODY_PARSE_DEBT.get(label);
      const hands: string[] = [];

      // INVARIANT: a module names the operation whose request it handles, never a schema — an
      // imported request schema is a second authority nothing reconciles with the manifest.
      // A module downstream of a Route Handler receives a body `jsonBody` already parsed, so
      // holding the schema at all can only mean parsing it twice with two separate authorities.
      const imports = (source.match(/^import[\s\S]*?;$/gm) ?? []).join("\n");
      for (const symbol of requestContractSymbols) {
        if (!new RegExp(`\\b${symbol}\\b`).test(imports)) continue;
        if (MODULE_FORM_CONTRACT_PARSERS.has(label)) {
          exercisedFormExemptions.add(label);
          continue;
        }
        hands.push(`${label}: imports request contract ${symbol}`);
      }
      if (LOCAL_BODY_PARSE.test(source)) {
        hands.push(`${label}: re-parses the body jsonBody already parsed`);
      }
      if (UNDECLARED_BODY_READ.test(source)) {
        hands.push(`${label}: reads jsonBody without naming its operation`);
      }
      if (LOCAL_QUERY_PARSE.test(source)) queryDoors.push(label);
      if (owed !== undefined && hands.length === 0) {
        settledDebt.push(`${label}: no longer parses its own body; drop the debt entry`);
      }
      if (owed === undefined) offenders.push(...hands);

      const ids = [...source.matchAll(OPERATION_ID_LITERAL)].map((match) => match[1]!);
      if (ids.length > 0) filesNamingAnOperation += 1;
      for (const id of ids) {
        if (!namesADeclaredOperation(id, declaredIds)) {
          offenders.push(`${label}: names operation ${id}, which the manifest does not declare`);
        }
      }
      for (const [, ref] of source.matchAll(CONTRACT_REF_LITERAL)) {
        if (!declaredRefs.has(ref!)) {
          offenders.push(`${label}: names ${ref}, which the manifest does not declare`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(settledDebt).toEqual([]);
    // Self-check: every recorded debt must point at a real operation.
    for (const [label, operationId] of MODULE_BODY_PARSE_DEBT) {
      expect(files.map((file) => relative(moduleRoot, file).split(sep).join("/")), label)
        .toContain(label);
      expect(declaredIds.has(operationId), operationId).toBe(true);
    }
    // Self-check: a form-parser exemption that no longer holds a contract must be deleted,
    // and it must name the multipart operation it exists for.
    for (const [label, operationId] of MODULE_FORM_CONTRACT_PARSERS) {
      expect(declaredIds.has(operationId), operationId).toBe(true);
      expect(exercisedFormExemptions, `${label} no longer needs its exemption`)
        .toContain(label);
    }
    // INVARIANT: exactly one query door. `queryParams` reads `searchParams` once, in the file
    // that owns the manifest lookup; anywhere else is a module narrowing a query on its own.
    expect(queryDoors).toEqual([QUERY_DOOR]);
    // Self-check: an assertion that inspected no operation key is not a guard.
    expect(filesNamingAnOperation).toBeGreaterThan(0);
  });

  it("reads every declared query through the manifest, by operation id", async () => {
    const queryOperations = manifestQueryOperations();
    const requestContractSymbols = manifestRequestContractSymbols();
    // Self-check: a derivation that finds no read contract bans nothing, and a ban list that
    // drops the read half again is the exact blind spot this guard exists to close.
    expect(queryOperations.length).toBeGreaterThan(0);
    expect(
      queryOperations
        .map((operation) => operation.contract.request)
        .filter((ref) => !requestContractSymbols.has(ref)),
    ).toEqual([]);

    const sources = await Promise.all(
      [...await routeFiles(routeRoot), ...await moduleFiles(moduleRoot)]
        .map((file) => readFile(file, "utf8")),
    );
    const named = new Set(
      sources.flatMap((source) => [...source.matchAll(OPERATION_ID_LITERAL)].map((m) => m[1]!)),
    );

    // INVARIANT: a declared query contract that no handler names is a contract nothing parses
    // against — the manifest would claim a shape the runtime never applies.
    expect(
      queryOperations.map((operation) => operation.id).filter((id) => !named.has(id)),
    ).toEqual([]);
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
