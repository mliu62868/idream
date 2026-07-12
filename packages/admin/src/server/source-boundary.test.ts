import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(packageRoot, "../..");

describe("admin source boundary", () => {
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
    expect(billingFeature).toContain("/api/v1/admin/billing/adjustments");
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
    expect(catchAll).not.toContain("/api/v1/admin/moderation/");
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
    expect(catchAll).not.toContain("/api/v1/admin/approvals");
    expect(support).toContain("export function SupportWorkspace");
    expect(promo).toContain("export function PromoWorkspace");
    expect(approvals).toContain("export function ApprovalsWorkspace");
  });

  it("keeps the Chat Ops authority out of the catch-all client", async () => {
    const catchAll = await readFile(path.join(packageRoot, "src/components/admin/AdminConsoleClient.tsx"), "utf8");
    const chat = await readFile(path.join(packageRoot, "src/features/chat-ops/ChatOpsWorkspace.tsx"), "utf8").catch(() => "");

    expect(catchAll).not.toContain("function ChatOpsView");
    expect(catchAll).not.toContain("/api/v1/admin/chat/");
    expect(chat).toContain("export function ChatOpsWorkspace");
  });
});
