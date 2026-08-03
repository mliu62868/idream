import type { Metadata } from "next";
import { adminBootstrapSchema, type AdminBootstrap } from "@idream/shared/admin";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { canReadAnyWorkspace, parseAdminPath } from "@/components/admin/nav-config";
import { proxyToMain } from "@/server/main-proxy";
import { AdminConsoleClientOnly } from "../AdminConsoleClientOnly";

export type AdminSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function adminRouteMetadata(label: string): Metadata {
  return {
    title: `${label} | iDream Admin`,
    robots: { index: false, follow: false },
  };
}

export function adminRouteLabel(section: readonly string[]) {
  return section.length === 0
    ? "Today"
    : section
        .map((part) => part.replaceAll("-", " "))
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" · ");
}

export async function renderAdminRoute(
  section: readonly string[],
  searchParams: AdminSearchParams,
) {
  const query = await searchParams;
  const initialSection = withSearchParams(section.join("/"), query);
  // SPEC: 认不出的后台路径回 404，走 app/admin/not-found.tsx。
  // INTENT: 在取 bootstrap 之前判——拼错的 URL 不该先打一次权威服务再显示成 Today。
  if (!parseAdminPath(initialSection)) notFound();

  const headerList = await headers();
  const bootstrap = await loadBootstrap(headerList);
  if (!bootstrap) return <AdminAuthorityUnavailable />;

  const canReadAdmin = Boolean(bootstrap.actor)
    && canReadAnyWorkspace(new Set(bootstrap.permissions));

  if (!canReadAdmin && bootstrap.devLogin.enabled) {
    return (
      <AdminDevLogin
        accounts={bootstrap.devLogin.accounts}
        actor={bootstrap.actor}
      />
    );
  }

  return (
    <AdminConsoleClientOnly
      actor={bootstrap.actor}
      initialAccess={Boolean(bootstrap.actor)}
      initialPermissions={bootstrap.permissions}
      initialSection={initialSection}
      shellSignals={bootstrap.shellSignals}
      devLogout={bootstrap.devLogin.enabled}
    />
  );
}

async function loadBootstrap(requestHeaders: Headers): Promise<AdminBootstrap | null> {
  const response = await proxyToMain(
    new Request("http://admin.local/api/v2/admin/bootstrap", { headers: requestHeaders }),
    "/api/v2/admin/bootstrap",
  );
  if (!response.ok) return null;
  const envelope = await response.json() as { data?: { bootstrap?: unknown } };
  const parsed = adminBootstrapSchema.safeParse(envelope.data?.bootstrap);
  return parsed.success ? parsed.data : null;
}

function AdminAuthorityUnavailable() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-lg font-semibold">后台权威服务不可用</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          控制面当前无法验证身份、权限和数据来源。权威服务恢复前，后台数据与操作均不可用。
        </p>
      </section>
    </main>
  );
}

function withSearchParams(
  path: string,
  values: Readonly<Record<string, string | string[] | undefined>>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return `${path}${encoded ? `?${encoded}` : ""}`;
}
