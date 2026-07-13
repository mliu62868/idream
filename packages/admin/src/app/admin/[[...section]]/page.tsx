import type { Metadata } from "next";
import { adminBootstrapSchema, type AdminBootstrap } from "@idream/shared/admin";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { adminEntryRedirect, canReadAnyWorkspace } from "@/components/admin/nav-config";
import { proxyToMain } from "../../../server/main-proxy";
import { AdminConsoleClientOnly } from "../AdminConsoleClientOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminPageProps = {
  params: Promise<{
    section?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<AdminPageProps, "params">): Promise<Metadata> {
  const { section = [] } = await params;
  const sectionId = section.length === 0 ? "today" : section.join("/");
  const label = sectionId
    .split("/")
    .filter(Boolean)
    .map((part) => part.replaceAll("-", " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
  return {
    title: `${label || "Today"} | iDream Admin`,
    robots: { index: false, follow: false },
  };
}

export default async function AdminPage({ params, searchParams }: AdminPageProps) {
  const { section = [] } = await params;
  const query = await searchParams;
  const entryRedirect = adminEntryRedirect(section, query);
  if (entryRedirect) redirect(entryRedirect);

  const headerList = await headers();
  const bootstrap = await loadBootstrap(headerList);
  if (!bootstrap) return <AdminAuthorityUnavailable />;
  const canReadAdmin = Boolean(bootstrap.actor) && canReadAnyWorkspace(new Set(bootstrap.permissions));

  // 本地开发：无后台权限时给出内置账号的快捷登录，而非裸的 access denied。
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
      initialSection={withSearchParams(section.join("/"), query)}
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
        <h1 className="text-lg font-semibold">Admin authority unavailable</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          The control plane could not verify identity, permissions, and data provenance. No admin data or actions are available until the authority service recovers.
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
