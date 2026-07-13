import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";

const adminRoot = path.resolve(import.meta.dirname);
const canonicalPageFiles = [
  "today/page.tsx",
  "characters/page.tsx",
  "characters/new/page.tsx",
  "characters/[id]/page.tsx",
  "creative/runs/page.tsx",
  "creative/runs/[id]/page.tsx",
  "ops/incidents/page.tsx",
  "ops/incidents/[id]/page.tsx",
  "cases/page.tsx",
  "cases/[id]/page.tsx",
  "ops/jobs/page.tsx",
] as const;

describe("canonical Admin route shell", () => {
  it("ships each core decision workspace as a physical Next page", async () => {
    await Promise.all(canonicalPageFiles.map((relativePath) => access(path.join(adminRoot, relativePath))));

    for (const relativePath of canonicalPageFiles) {
      const source = await readFile(path.join(adminRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("renderAdminRoute(");
      expect(source, relativePath).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("retains the optional catch-all as compatibility glue over the shared renderer", async () => {
    const source = await readFile(path.join(adminRoot, "[[...section]]/page.tsx"), "utf8");
    const renderer = await readFile(path.join(adminRoot, "_server/render-admin-route.tsx"), "utf8");

    expect(source).toContain("adminEntryRedirect");
    expect(source).toContain("renderAdminRoute(section");
    expect(source).not.toContain("loadBootstrap");
    expect(renderer).toContain("loadBootstrap");
    expect(renderer).toContain("canReadAnyWorkspace");
    expect(renderer).toContain("<AdminConsoleClientOnly");
  });

  it("keeps the initial SSR and hydration render deterministic with a closed drawer", () => {
    const props = {
      actor: { id: "operator-1", role: "admin" },
      initialAccess: true,
      initialPermissions: ["dashboard.read"] as AdminPermissionKey[],
      initialSection: "today",
      shellSignals: {
        environment: "test" as const,
        dataClass: "fixture" as const,
        fixtureState: "included" as const,
        productTimezone: "UTC",
        freshness: { state: "reported" as const, label: "2026-07-12T00:00:00.000Z" },
      },
    };
    const serverMarkup = renderToString(<AdminConsoleClient {...props} />);
    const hydrationMarkup = renderToString(<AdminConsoleClient {...props} />);

    expect(hydrationMarkup).toBe(serverMarkup);
    expect(serverMarkup).toContain('aria-controls="admin-mobile-navigation"');
    expect(serverMarkup).toContain('aria-expanded="false"');
    expect(serverMarkup).not.toContain('id="admin-mobile-navigation"');
  });

  it("uses an accessible drawer instead of a horizontal link strip below desktop", async () => {
    const source = await readFile(
      path.resolve(adminRoot, "../../components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );

    expect(source).not.toContain('<nav className="flex gap-2 overflow-x-auto');
    expect(source).toContain('aria-controls="admin-mobile-navigation"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("trigger?.focus()");
    expect(source).toContain('window.matchMedia("(min-width: 1280px)")');
    expect(source).toContain("xl:flex xl:flex-col");
  });
});
