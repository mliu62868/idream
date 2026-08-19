"use client";

import Link from "next/link";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminI18nProvider, useAdminI18n } from "@/components/admin/i18n";
import type { AdminLocale } from "@/components/admin/shell-preferences";
import {
  matchAdminDestinations,
  type AdminDestination,
} from "@/features/search/admin-destinations";

// SPEC: 后台的两张"整页消息"——路径不存在、权威服务不可用。
// INTENT: 两张页面原先都是硬编码中文，英文 locale 下直接露馅；而语言偏好是 cookie，服务端
//         读得到，所以由外面把 locale 传进来，这里照常走 i18n。做成客户端组件是因为
//         translateAdmin/useAdminI18n 都在 "use client" 模块里，服务端组件调不动。

export function AdminNotFoundPage({
  attemptedPath,
  locale,
  permissions,
}: {
  attemptedPath: string | null;
  locale: AdminLocale;
  permissions: readonly AdminPermissionKey[];
}) {
  return (
    <AdminI18nProvider locale={locale}>
      <NotFoundBody attemptedPath={attemptedPath} permissions={permissions} />
    </AdminI18nProvider>
  );
}

const SUGGESTION_LIMIT = 4;

// SPEC: 从认不出的路径里猜出最接近的几个目的地。
// INTENT: 这张页面原先只有一个「返回今日工作」按钮——而运营走到这里多半是书签失效或 URL 拼错，
//         真正想去的那一页往往就在导航里。
// INTENT: 先拿整条路径匹配（旧的完整路径最可能整段命中），不中再逐段回退、由细到粗：
//         /admin/ops/deadletter 里 "deadletter" 谁也不像，但 "ops" 能把同组的运维页捞回来。
//         匹配器不做分词也不做编辑距离——那是搜索框的活儿，这里只要"别把人堵死"。
// INVARIANT: 只建议运营真读得进去的页面。建议一个他点开还是被拒的目的地，等于把 404 换成了
//            另一堵墙。
function suggestDestinations(
  attemptedPath: string | null,
  permissions: readonly AdminPermissionKey[],
) {
  if (!attemptedPath) return [];
  const held = new Set(permissions);
  const segments = attemptedPath.split("/").filter(Boolean);
  const attempts = [attemptedPath, ...segments.reverse()];
  const found = new Map<string, AdminDestination>();

  for (const attempt of attempts) {
    for (const destination of matchAdminDestinations(attempt, held, SUGGESTION_LIMIT)) {
      if (!found.has(destination.id)) found.set(destination.id, destination);
      if (found.size >= SUGGESTION_LIMIT) return [...found.values()];
    }
  }
  return [...found.values()];
}

function NotFoundBody({
  attemptedPath,
  permissions,
}: {
  attemptedPath: string | null;
  permissions: readonly AdminPermissionKey[];
}) {
  const { t } = useAdminI18n();
  const suggestions = suggestDestinations(attemptedPath, permissions);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="w-full max-w-md rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-xl font-semibold">{t("Admin workspace not found")}</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("This route is not part of the current console information architecture.")}
        </p>
        {attemptedPath ? (
          <p
            className="mt-3 truncate rounded-md bg-[var(--ad-surface-subtle)] px-2 py-1 font-mono text-xs"
            data-testid="admin-not-found-path"
          >
            {`/admin/${attemptedPath}`}
          </p>
        ) : null}

        {suggestions.length > 0 ? (
          <>
            <p className="mt-5 text-[11px] font-semibold uppercase text-[var(--ad-text-muted)]">
              {t("Closest workspaces")}
            </p>
            <ul className="mt-1.5 grid gap-1" data-testid="admin-not-found-suggestions">
              {suggestions.map((destination) => {
                const Icon = destination.icon;
                return (
                  <li key={destination.id}>
                    <Link
                      className="flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm hover:bg-black/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                      href={destination.href}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
                      <span className="truncate font-medium">{t(destination.label)}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-[var(--ad-text-muted)]">
                        {t(destination.group)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <Link
          className="mt-5 inline-flex min-h-11 items-center rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
          href="/admin/today"
        >
          {t("Back to Today")}
        </Link>
      </section>
    </main>
  );
}

export function AdminAuthorityUnavailablePage({ locale }: { locale: AdminLocale }) {
  return (
    <AdminI18nProvider locale={locale}>
      <AuthorityUnavailableBody />
    </AdminI18nProvider>
  );
}

function AuthorityUnavailableBody() {
  const { t } = useAdminI18n();

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-lg font-semibold">{t("Admin authority service unavailable")}</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("The control plane cannot verify identity, permissions, or data provenance right now. Admin data and commands stay unavailable until the authority service recovers.")}
        </p>
      </section>
    </main>
  );
}
