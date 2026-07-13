import { describe, expect, it } from "vitest";
import { ADMIN_V2_API_OPERATIONS, type AdminV2ApiOperation } from "@idream/shared/admin/api-manifest";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { readonly eager: true }): Record<string, T>;
  }
}

type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

type RouteModule = Partial<Record<AdminV2ApiOperation["method"], RouteHandler>>;

const routeModules = import.meta.glob<RouteModule>(
  "../../../../app/api/v2/admin/**/route.ts",
  { eager: true },
);

function moduleKey(operation: AdminV2ApiOperation) {
  const route = operation.route.replace(/:([^/]+)/g, "[$1]");
  return `../../../../app${route}/route.ts`;
}

function concreteRoute(operation: AdminV2ApiOperation) {
  return operation.route.replace(/:([^/]+)/g, (_, key: string) => parameterValue(key));
}

function params(operation: AdminV2ApiOperation) {
  return Object.fromEntries(
    [...operation.route.matchAll(/:([^/]+)/g)].map((match) => [match[1], parameterValue(match[1] ?? "id")]),
  );
}

function parameterValue(key: string) {
  if (key === "targetType") return "case";
  if (key === "window") return "24h";
  if (key === "bundleKey") return "creative_operator";
  return `${key}-fixture`;
}

describe("Admin v2 authority execution matrix", () => {
  it("executes authentication before body parsing or data access for every protected operation", async () => {
    const outcomes: Array<{ id: string; status: number }> = [];
    for (const operation of ADMIN_V2_API_OPERATIONS) {
      if (operation.authorization.kind === "bootstrap") continue;
      const routeModule = routeModules[moduleKey(operation)];
      const handler = routeModule?.[operation.method];
      expect(handler, operation.id).toBeTypeOf("function");
      const body = operation.method === "GET" || operation.method === "DELETE"
        ? undefined
        : JSON.stringify({});
      const response = await handler!(
        new Request(`http://localhost${concreteRoute(operation)}`, {
          method: operation.method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body,
        }),
        { params: Promise.resolve(params(operation)) },
      );
      outcomes.push({ id: operation.id, status: response.status });
    }

    expect(outcomes).toHaveLength(84);
    expect(outcomes.filter((outcome) => outcome.status !== 401)).toEqual([]);
  });
});
