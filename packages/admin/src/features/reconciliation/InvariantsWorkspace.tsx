"use client";

// SPEC: 数据一致性不变式的运营界面。只读 + 手动刷新，没有写操作。
// INTENT: 后端 `GET /api/v2/admin/reconciliation/invariants` 一直在算 31 条跨表不变式，
//         实测 17 条违规、`decisionUse: "blocked"` —— 而整个 admin 前端零引用。那些"运营
//         看不见"的异常（发布链路断头、结算与账本对不上、开着的举报没有工单）全在这份报告里
//         躺着，只是没有任何一页显示它。这一页就是那个缺失的界面。
// INVARIANT: 不新增后端能力，也不替后端下判断——结论（qualityState / decisionUse /
//            totalViolations）一律照抄权威，界面只负责让它可读、可分诊、可转交。

import { useCallback, useMemo } from "react";
import { CircleCheck, Loader2, RefreshCcw, ShieldAlert } from "lucide-react";
import type { AdminInvariantCheck, AdminInvariantReport } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { permissionDenied } from "@/features/characters/character-permission-denied";
import { hasInvariantCopy, invariantCopy, invariantOwnerBreakdown } from "./invariant-copy";

export function InvariantsWorkspace({ canRead }: { canRead: boolean }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const report = useAuthorityResource<AdminInvariantReport>({
    key: "reconciliation/invariants",
    enabled: canRead,
    load: useCallback(
      () => adminV2Operation("GET /api/v2/admin/reconciliation/invariants", {}),
      [],
    ),
  });

  const data = report.data;
  // SPEC: 排序只按「坏没坏」和「坏了多少」，不按后端返回顺序。
  // INTENT: 后端按检查定义顺序返回，于是 31 条里那 6 条失败的散落在中间；运营要的是把
  //         失败的顶到最上面。unavailable 排在 failed 之后——"没查成"比"查出问题"更弱。
  const { failed, unavailable, passed } = useMemo(() => partition(data?.checks ?? []), [data]);
  const owners = useMemo(() => invariantOwnerBreakdown(data?.checks ?? []), [data]);

  if (!canRead) return permissionDenied("analytics.metric.read");

  return (
    <section className="space-y-5">
      <PageHeader
        action={
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold disabled:opacity-50"
            disabled={report.loading}
            onClick={() => void report.refresh()}
            type="button"
          >
            {report.loading ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw aria-hidden className="h-4 w-4" />
            )}
            {t("Refresh")}
          </button>
        }
        purpose={t(
          "Cross-table authority checks that no single workspace can see on its own.",
        )}
        title={t("Data Integrity")}
      />

      {report.error ? (
        <AuthorityRequestError
          cause={report.cause}
          message={report.error}
          onRetry={() => void report.refresh()}
          snapshotAt={data ? report.refreshedAt : null}
        />
      ) : null}

      {report.loading && !data ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">
          {t("Loading data-integrity checks…")}
        </p>
      ) : null}

      {data ? (
        <>
          <Verdict
            asOf={format.dateTime(data.asOf)}
            decisionUse={data.decisionUse}
            failedCount={failed.length}
            owners={owners}
            totalChecks={data.checks.length}
            totalViolations={data.totalViolations}
            unavailableCount={unavailable.length}
          />

          {failed.length === 0 && unavailable.length === 0 ? (
            <EmptyState
              hint="Every cross-table check the authority runs came back clean."
              title={t("All data-integrity checks passed")}
            />
          ) : (
            <ul className="space-y-3">
              {[...failed, ...unavailable].map((check) => (
                <CheckCard check={check} key={check.key} />
              ))}
            </ul>
          )}

          {passed.length > 0 ? (
            <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3">
              <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("{count} checks passed", { count: passed.length })}
              </summary>
              <ul className="mt-3 space-y-1.5">
                {passed.map((check) => (
                  <li className="text-xs text-[var(--ad-text-muted)]" key={check.key}>
                    <CircleCheck aria-hidden className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
                    {t(invariantCopy(check.key).title)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

        </>
      ) : null}
    </section>
  );
}

function partition(checks: readonly AdminInvariantCheck[]) {
  const failed: AdminInvariantCheck[] = [];
  const unavailable: AdminInvariantCheck[] = [];
  const passed: AdminInvariantCheck[] = [];
  for (const check of checks) {
    if (check.status === "failed") failed.push(check);
    else if (check.status === "unavailable") unavailable.push(check);
    else passed.push(check);
  }
  failed.sort((left, right) => (right.violationCount ?? 0) - (left.violationCount ?? 0));
  return { failed, unavailable, passed };
}

// SPEC: 顶部结论条回答三个问题：能不能用于决策、坏了几条、这批该谁收口。
// INTENT: 「17 条违规」本身不构成行动。运营真正要先分的是"我能自己处理的"和"只能转工程的"
//         —— 这一刀切下去，剩下的卡片才有阅读顺序。
function Verdict({
  asOf,
  decisionUse,
  failedCount,
  owners,
  totalChecks,
  totalViolations,
  unavailableCount,
}: {
  asOf: string;
  decisionUse: AdminInvariantReport["decisionUse"];
  failedCount: number;
  owners: { operations: number; engineering: number };
  totalChecks: number;
  totalViolations: number;
  unavailableCount: number;
}) {
  const { t } = useAdminI18n();
  const blocked = decisionUse === "blocked";
  return (
    <div
      className={
        blocked
          ? "rounded-lg bg-[var(--ad-red-bg)] p-4 text-[var(--ad-red-text)]"
          : "rounded-lg bg-[var(--ad-green-bg)] p-4 text-[var(--ad-green-text)]"
      }
      role="status"
    >
      <div className="flex items-center gap-2">
        {blocked ? (
          <ShieldAlert aria-hidden className="h-5 w-5" />
        ) : (
          <CircleCheck aria-hidden className="h-5 w-5" />
        )}
        <strong className="text-sm font-semibold">
          {/* SPEC: 一条违规都没有、却因为有检查没跑成而 blocked —— 契约允许（unavailableChecks>0
              就足以让 qualityState=invalid），此时"0 条违规、0/31 条检查"是句废话。 */}
          {!blocked
            ? t("{total} checks passed", { total: totalChecks })
            : failedCount === 0
              ? t("{count} of {total} checks could not be run", {
                  count: unavailableCount,
                  total: totalChecks,
                })
              : t("{violations} violations across {failed} of {total} checks", {
                  violations: totalViolations,
                  failed: failedCount,
                  total: totalChecks,
                })}
        </strong>
      </div>
      <p className="mt-2 text-xs">
        {blocked
          ? t(
              "Downstream numbers built on these tables are not safe for decisions until they clear.",
            )
          : t("Downstream numbers built on these tables are safe for decisions.")}
      </p>
      {/* 只有 failed 才有"该找谁"可分；没跑成的那些单列，不塞进任何一个桶。 */}
      {failedCount > 0 ? (
        <p className="mt-2 text-xs">
          {t("{count} you can close yourself", { count: owners.operations })}
          <span aria-hidden> · </span>
          {t("{count} need engineering", { count: owners.engineering })}
          {unavailableCount > 0 ? (
            <>
              <span aria-hidden> · </span>
              {t("{count} could not be checked", { count: unavailableCount })}
            </>
          ) : null}
        </p>
      ) : unavailableCount > 0 ? (
        <p className="mt-2 text-xs">
          {t("{count} could not be checked", { count: unavailableCount })}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] opacity-80">
        {t("asOf")} {asOf}
      </p>
    </div>
  );
}

function CheckCard({ check }: { check: AdminInvariantCheck }) {
  const { t } = useAdminI18n();
  const copy = invariantCopy(check.key);
  const recognised = hasInvariantCopy(check.key);
  return (
    <li className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm font-semibold text-[var(--ad-ink)]">{t(copy.title)}</strong>
        <span
          className={
            copy.owner === "operations"
              ? "rounded bg-[var(--ad-yellow-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ad-yellow-text)]"
              : "rounded bg-black/[0.06] px-2 py-0.5 text-[11px] font-semibold text-[var(--ad-text-muted)]"
          }
        >
          {t(copy.owner === "operations" ? "Operations can close this" : "Needs engineering")}
        </span>
        <span className="text-xs tabular-nums text-[var(--ad-text-muted)]">
          {check.status === "unavailable"
            ? t("could not be checked")
            : t("{count} violations", { count: check.violationCount ?? 0 })}
        </span>
      </div>

      {/* 字典没收录时，后端那句正式陈述就是运营首屏唯一的信息，必须提上来而不是折起来。 */}
      {recognised ? null : (
        <p className="mt-1.5 text-xs text-[var(--ad-text-muted)]">{check.description}</p>
      )}

      <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t(copy.hint)}</p>

      {check.sampleIds.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
            {t("Samples")}
          </span>
          {check.sampleIds.map((id) => (
            <CopyableId key={id} value={id} />
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <EngineeringDetails summary={check.key}>
          <div className="space-y-1">
            <div>{check.description}</div>
            <div>{check.evidence}</div>
          </div>
        </EngineeringDetails>
      </div>
    </li>
  );
}
