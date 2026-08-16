import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(packageRoot, "../..");

describe("admin source boundary", () => {
  it("server-renders the interactive shell behind route-level recovery boundaries", async () => {
    const clientEntry = await readFile(path.join(packageRoot, "src/app/admin/AdminConsoleClientOnly.tsx"), "utf8");
    const routePage = await readFile(path.join(packageRoot, "src/app/admin/[[...section]]/page.tsx"), "utf8");
    const routeRenderer = await readFile(path.join(packageRoot, "src/app/admin/_server/render-admin-route.tsx"), "utf8");
    const loading = await readFile(path.join(packageRoot, "src/app/admin/loading.tsx"), "utf8");
    const error = await readFile(path.join(packageRoot, "src/app/admin/error.tsx"), "utf8");
    const notFound = await readFile(path.join(packageRoot, "src/app/admin/not-found.tsx"), "utf8");

    expect(clientEntry).not.toContain("ssr: false");
    expect(clientEntry).not.toContain("next/dynamic");
    expect(clientEntry).toContain("<AdminConsoleClient");
    expect(routePage).toContain("export async function generateMetadata");
    expect(routePage).toContain("renderAdminRoute(section");
    expect(routeRenderer).toContain("<AdminConsoleClientOnly");
    expect(loading).toContain('aria-busy="true"');
    expect(error).toContain('role="alert"');
    expect(notFound).toContain('href="/admin/today"');
  });

  it("resolves application source from the admin package only", async () => {
    const tsconfig = await readFile(path.join(packageRoot, "tsconfig.json"), "utf8");
    const globals = await readFile(path.join(packageRoot, "src/app/globals.css"), "utf8");
    const nextConfig = await readFile(path.join(packageRoot, "next.config.ts"), "utf8");
    const turboConfig = await readFile(path.join(workspaceRoot, "turbo.json"), "utf8");

    expect(tsconfig).not.toContain("../main/src");
    expect(globals).not.toContain("main/src");
    expect(nextConfig).not.toContain("../main/src");
    expect(nextConfig).not.toContain("reuses TS source from packages/main");
    expect(turboConfig).not.toContain("../main/src");
    expect(turboConfig).not.toContain("../main/prisma");
    const legacyMainUi = await readdir(path.join(workspaceRoot, "packages/main/src/components/admin"), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    expect(legacyMainUi.filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))).toEqual([]);
  });

  it("keeps the migrated Audit domain out of the catch-all client", async () => {
    const catchAll = await readFile(
      path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );
    const auditFeature = await readFile(
      path.join(packageRoot, "src/features/audit/AuditWorkspace.tsx"),
      "utf8",
    ).catch(() => "");

    expect(catchAll).not.toContain("/api/v1/admin/audit-log");
    expect(catchAll).not.toContain("function AuditView");
    expect(auditFeature).toContain("export function AuditWorkspace");
  });

  it("keeps the migrated Pricing domain and its writes out of the catch-all client", async () => {
    const catchAll = await readFile(
      path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );
    const pricingFeature = await readFile(
      path.join(packageRoot, "src/features/pricing/PricingWorkspace.tsx"),
      "utf8",
    );

    expect(catchAll).not.toContain("/api/v1/admin/pricing/rules");
    expect(catchAll).not.toContain("function PricingView");
    expect(pricingFeature).toContain("config.pricing.write");
    expect(pricingFeature).toContain("export function PricingWorkspace");
  });

  it("keeps the migrated Billing domain and its writes out of the catch-all client", async () => {
    const catchAll = await readFile(
      path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );
    const billingFeature = await readFile(
      path.join(packageRoot, "src/features/billing/BillingWorkspace.tsx"),
      "utf8",
    ).catch(() => "");

    expect(catchAll).not.toContain("/api/v1/admin/billing/");
    expect(catchAll).not.toContain("function BillingView");
    expect(billingFeature).toContain("export function BillingWorkspace");
    expect(billingFeature).toContain("/api/v2/admin/billing/adjustments");
    expect(catchAll).toContain("window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))");
    expect(billingFeature).toContain("window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh)");
  });

  it("keeps migrated generation config and dead-letter domains out of the catch-all client", async () => {
    const catchAll = await readFile(
      path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );
    const configFeature = await readFile(
      path.join(packageRoot, "src/features/config/GenerationConfigWorkspace.tsx"),
      "utf8",
    ).catch(() => "");
    const deadLetterFeature = await readFile(
      path.join(packageRoot, "src/features/dead-letter/DeadLetterWorkspace.tsx"),
      "utf8",
    ).catch(() => "");

    expect(catchAll).not.toContain("/api/v1/admin/generation/model-profiles");
    expect(catchAll).not.toContain("/api/v1/admin/feature-flags");
    expect(catchAll).not.toContain("/api/v1/admin/generation/dead-letter");
    expect(catchAll).not.toContain("function ConfigView");
    expect(catchAll).not.toContain("function DeadLetterView");
    expect(configFeature).toContain("export function GenerationConfigWorkspace");
    expect(deadLetterFeature).toContain("export function DeadLetterWorkspace");
  });

  it("keeps migrated access and moderation domains out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const access = await readFile(path.join(packageRoot, "src/features/access/AccessWorkspace.tsx"), "utf8").catch(() => "");
    const moderation = await readFile(path.join(packageRoot, "src/features/moderation/ModerationWorkspace.tsx"), "utf8").catch(() => "");

    expect(catchAll).not.toContain("function UsersView");
    expect(catchAll).not.toContain("function ModerationView");
    expect(catchAll).not.toContain("/api/v2/admin/moderation/");
    expect(access).toContain("export function AccessWorkspace");
    expect(moderation).toContain("export function ModerationWorkspace");
  });

  it("keeps support, promo, and approvals authorities out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const support = await readFile(path.join(packageRoot, "src/features/support/SupportWorkspace.tsx"), "utf8").catch(() => "");
    const promo = await readFile(path.join(packageRoot, "src/features/promo/PromoWorkspace.tsx"), "utf8").catch(() => "");
    const approvals = await readFile(path.join(packageRoot, "src/features/approvals/ApprovalsWorkspace.tsx"), "utf8").catch(() => "");

    expect(catchAll).not.toContain("function SupportRequestsView");
    expect(catchAll).not.toContain("function PromoView");
    expect(catchAll).not.toContain("function ApprovalsView");
    expect(catchAll).not.toContain("/api/v1/admin/support/requests");
    expect(catchAll).not.toContain("/api/v1/admin/promo/");
    expect(catchAll).not.toContain("/api/v2/admin/approvals");
    expect(support).toContain("export function SupportWorkspace");
    expect(promo).toContain("export function PromoWorkspace");
    expect(approvals).toContain("export function ApprovalsWorkspace");
  });

  it("keeps the Chat Ops authority out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const chat = await readFile(path.join(packageRoot, "src/features/chat-ops/ChatOpsWorkspace.tsx"), "utf8").catch(() => "");

    expect(catchAll).not.toContain("function ChatOpsView");
    expect(catchAll).not.toContain("/api/v2/admin/chat/");
    expect(chat).toContain("export function ChatOpsWorkspace");
  });

  it("keeps content merchandising authority out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const content = await readFile(path.join(packageRoot, "src/features/content-merchandising/ContentMerchandisingWorkspace.tsx"), "utf8").catch(() => "");
    expect(catchAll).not.toContain("function ContentView");
    expect(catchAll).not.toContain("/api/v1/admin/content/characters");
    expect(catchAll).not.toContain("/api/v1/admin/content/featured");
    expect(content).toContain("export function ContentMerchandisingWorkspace");
  });

  it("keeps operational overviews out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const overviews = await readFile(path.join(packageRoot, "src/features/overviews/OverviewWorkspaces.tsx"), "utf8").catch(() => "");
    expect(catchAll).not.toContain("function AnalyticsView");
    expect(catchAll).not.toContain("function RiskView");
    expect(catchAll).not.toContain("function ProviderOpsView");
    expect(catchAll).not.toContain("/api/v1/admin/analytics/overview");
    expect(catchAll).not.toContain("/api/v2/admin/analytics/overview");
    expect(catchAll).not.toContain("/api/v1/admin/risk/abuse");
    expect(catchAll).not.toContain("/api/v2/admin/risk/abuse");
    expect(catchAll).not.toContain("/api/v1/admin/ops/providers");
    expect(overviews).toContain("export function AnalyticsWorkspace");
    expect(overviews).toContain("export function RiskWorkspace");
    expect(overviews).toContain("export function ProviderOverviewWorkspace");
  });
});
