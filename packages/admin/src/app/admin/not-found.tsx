"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_PERMISSION_KEYS, type AdminPermissionKey } from "@idream/shared/admin/permissions";
import { translateAdmin } from "@/components/admin/i18n";
import { readAdminLocaleFromDocument } from "@/components/admin/shell-preferences";
import { matchAdminDestinations } from "@/features/search/admin-destinations";

// SPEC: 认不出的后台 URL 落到这一页。它要说清三件事：这个地址不存在、运营敲进去的是什么、
//       以及最接近的几个真实目的地。状态码由 src/proxy.ts 定成 404。
// INTENT: 这一页原来整页硬编码中文，且只有一个「返回今日工作」的出口——到这一页十有八九是
//         URL 打错或旧书签失效，而 34 个目的地全都在 nav-config 里躺着，猜一把的成本极低。
// INTENT: 和 error.tsx、ui/Toast.tsx 一样，这一页在 AdminI18nProvider 之外，直接查同一张
//         词典，不是第二套 i18n。
// INVARIANT: 建议只按 URL 猜，不按权限筛——这一页在 bootstrap 之外渲染，拿不到 actor 的权限集。
//            猜中一个运营打不开的工作台，他至少会撞上「缺哪几个键、找谁授予」那一页；
//            一条建议都不给才是真正的死胡同。
const EVERY_PERMISSION = new Set<AdminPermissionKey>(ADMIN_PERMISSION_KEYS);
const SUGGESTION_LIMIT = 4;

export default function AdminNotFound() {
  const locale = readAdminLocaleFromDocument();
  const t = (key: string) => translateAdmin(locale, key);
  const pathname = usePathname();
  const suggestions = matchAdminDestinations(lastSegment(pathname), EVERY_PERMISSION, SUGGESTION_LIMIT);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="w-full max-w-lg rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-xl font-semibold">{t("This admin route does not exist.")}</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("Nothing in the control-plane information architecture answers this URL. It was most likely mistyped, or the page has moved.")}
        </p>
        <p className="mt-3 break-all rounded-md border border-[var(--ad-border)] bg-black/[0.03] px-3 py-2 font-mono text-xs text-[var(--ad-text-muted)]">
          {pathname}
        </p>

        {suggestions.length > 0 && (
          <nav className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
              {t("You may be looking for")}
            </h2>
            <ul className="mt-1">
              {suggestions.map((destination) => (
                <li key={destination.id}>
                  <Link
                    className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-black/[0.04]"
                    href={destination.href}
                  >
                    <destination.icon aria-hidden className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
                    <span className="font-medium">{t(destination.label)}</span>
                    <span className="text-xs text-[var(--ad-text-muted)]">{t(destination.group)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <Link
          className="mt-5 inline-flex min-h-11 items-center rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
          href="/admin/today"
        >
          {t("Back to Today")}
        </Link>
      </section>
    </main>
  );
}

// 用最后一段当搜索词：/admin/growth/funnel 里有信息量的是 "funnel"。目的地索引里含 href，
// 所以少一个字母、单复数写错这类拼法仍能命中。
function lastSegment(pathname: string) {
  return pathname.split("/").filter(Boolean).at(-1) ?? "";
}
