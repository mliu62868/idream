"use client";

import Link from "next/link";
import {
  adminCommandStatusSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CreativeRun,
  type CreativeRunDetail,
  type AdminCommandStatus,
  type AdminPageInfo,
} from "@idream/shared/admin";
import { ArrowLeft, Check, ImageIcon, RefreshCcw, RotateCcw, Send, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import { formatDateTime } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { creativeRetryFailedMutation } from "@/features/image-workflow-transport";
import { EmptyWorkspace, LoadingWorkspace, StatusBadge, WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import {
  AdminV2RequestError,
  adminV2Request,
} from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  useAuthorityResource,
  usePollingTask,
  type PollingTask,
} from "@/lib/authority-resource";
import { cn } from "@/lib/utils";

type Permissions = { read: boolean; write: boolean; review: boolean; place: boolean; manageIncident?: boolean };

export function nonCampaignAssetSummary(hasAsset: boolean) {
  return hasAsset
    ? { title: "Asset ready", description: "Choose where to use this asset. Generation does not publish it automatically.", complete: true }
    : { title: "Waiting for an asset", description: "The asset will be available after generation and automatic checks finish.", complete: false };
}

export function committedProjectionWarning(
  action: string,
  cause: unknown,
) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return `${action} was committed, but the latest projection could not be refreshed${detail}. Retry the same command safely or refresh the workspace.`;
}

export function authoredCampaignPlacementCopy(input: {
  readonly eyebrow: string;
  readonly title: string;
  readonly ctaLabel: string;
  readonly href: string;
}) {
  const ctaLabel = input.ctaLabel.trim();
  const href = input.href.trim();
  return {
    eyebrow: input.eyebrow.trim(),
    title: input.title.trim(),
    ...(ctaLabel ? { ctaLabel } : {}),
    ...(href ? { href } : {}),
  };
}

type CreativeRetryCommandState = {
  readonly actorId: string;
  readonly createdAt: number;
  readonly commandId: string | null;
  readonly idempotencyKey: string;
  readonly entityVersion: number;
  readonly verificationDeepLink: string | null;
  readonly status:
    | AdminCommandStatus["status"]
    | "submitting"
    | "submission_unknown";
  readonly error?: unknown;
};

const creativeRetryIntentLifetimeMs = 24 * 60 * 60 * 1_000;

function creativeRetryStorageKey(runId: string, actorId: string) {
  return `idream:admin:creative-retry:v2:${encodeURIComponent(actorId)}:${encodeURIComponent(runId)}`;
}

function readCreativeRetryCommand(
  runId: string,
  actorId: string,
): CreativeRetryCommandState | null {
  if (typeof window === "undefined") return null;
  try {
    const key = creativeRetryStorageKey(runId, actorId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const commandId =
      value.commandId === null || typeof value.commandId === "string"
        ? value.commandId
        : undefined;
    const verificationDeepLink =
      value.verificationDeepLink === null ||
      typeof value.verificationDeepLink === "string"
        ? value.verificationDeepLink
        : undefined;
    if (
      commandId === undefined ||
      value.actorId !== actorId ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      Date.now() - value.createdAt > creativeRetryIntentLifetimeMs ||
      value.createdAt - Date.now() > 60_000 ||
      typeof value.idempotencyKey !== "string" ||
      verificationDeepLink === undefined ||
      typeof value.status !== "string" ||
      ![
        "submitting",
        "submission_unknown",
        "accepted",
        "running",
        "verifying",
        "succeeded",
        "failed",
        "cancelled",
      ].includes(value.status)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    const entityVersion =
      typeof value.entityVersion === "number" &&
      Number.isInteger(value.entityVersion) &&
      value.entityVersion >= 0
        ? value.entityVersion
        : commandId === null
          ? null
          : 0;
    if (entityVersion === null) return null;
    if (
      (value.status === "submitting" ||
        value.status === "submission_unknown") &&
      (commandId !== null || verificationDeepLink !== null)
    ) {
      return null;
    }
    if (
      value.status !== "submitting" &&
      value.status !== "submission_unknown" &&
      (commandId === null || verificationDeepLink === null)
    ) {
      return null;
    }
    return {
      actorId,
      createdAt: value.createdAt,
      commandId,
      idempotencyKey: value.idempotencyKey,
      entityVersion,
      verificationDeepLink,
      status: value.status as CreativeRetryCommandState["status"],
      ...(value.error === undefined ? {} : { error: value.error }),
    };
  } catch {
    return null;
  }
}

function persistCreativeRetryCommand(
  runId: string,
  actorId: string,
  value: CreativeRetryCommandState | null,
) {
  if (typeof window === "undefined") return;
  const key = creativeRetryStorageKey(runId, actorId);
  if (value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  } else {
    window.localStorage.removeItem(key);
  }
}

function creativeRetryFailureMessage(error: unknown) {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "Creative retry command failed. Open its audit trail for details.";
  }
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof record.code === "string" && record.code.trim()) {
    return record.code;
  }
  return "Creative retry command failed. Open its audit trail for details.";
}

function isDefinitiveAdminMutationRejection(
  cause: unknown,
): cause is AdminV2RequestError {
  return cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status);
}

function denied() {
  return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h2 className="mt-4 text-lg font-semibold"><AdminText text="No permission" /></h2><p className="mt-2 text-sm text-[var(--ad-text-muted)]"><AdminText text="creative.run.read is required for this workspace." /></p></section>;
}

type CreativeRunListQuery = {
  search: string;
  outcome: string;
  cursor?: string;
};

// INVARIANT: 常量空值，避免"资源尚未到达"每次渲染都产生新引用。
const EMPTY_CREATIVE_RUNS: readonly CreativeRun[] = [];
const EMPTY_PAGE_INFO: AdminPageInfo = { endCursor: null, hasNextPage: false };
const CREATIVE_RUN_PAGE_SIZE = 25;

// SPEC: 走过的游标存在 history entry 上，不只存在组件 state 里。
// INTENT: 这个列表原先只有「下一页」—— 25 条一页翻到第四页就回不去了。补上「上一页」要一份
//         走过的路；只存组件 state 的话，刷新和「后退」都会把它清空，页码就成了编的。
//         history.state 跟着这条 history entry 走；真的放不下游标时宁可回到第一页。
type RunListHistoryState = { cursorStack?: readonly string[] };

function restoredCursorStack(): readonly string[] {
  const state = window.history.state as RunListHistoryState | null;
  return Array.isArray(state?.cursorStack) ? state.cursorStack : [];
}

// SPEC: 请求参数与写进地址栏的参数必须是同一份，刷新页面才能复现同一页。
function creativeRunListParams(query: CreativeRunListQuery) {
  const params = new URLSearchParams({ limit: String(CREATIVE_RUN_PAGE_SIZE) });
  if (query.search.trim()) params.set("search", query.search.trim());
  if (query.outcome !== "all") params.set("executionOutcome", query.outcome);
  if (query.cursor) params.set("cursor", query.cursor);
  return params;
}

function RunList({ permissions }: { permissions: Permissions }) {
  const { locale, t } = useAdminI18n();
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  // SPEC: 已生效的查询与表单草稿分开保存。
  // INTENT: search/outcome 直接绑在输入框上，在搜索框里打字不该触发取数——只有 Apply
  //         / 翻页 / 地址栏恢复才更新 applied，也就是 useAuthorityResource 的 query key。
  const [applied, setApplied] = useState<CreativeRunListQuery>(
    () => ({ search: "", outcome: "all" }),
  );
  const [cursorStack, setCursorStack] = useState<readonly string[]>([]);

  const runs = useAuthorityResource({
    key: JSON.stringify(applied),
    enabled: permissions.read,
    load: useCallback(
      () =>
        adminV2Request(
          `/api/v2/admin/creative/runs?${creativeRunListParams(applied)}`,
          { schema: creativeRunListResponseSchema },
        ),
      [applied],
    ),
  });
  const items = runs.data?.items ?? EMPTY_CREATIVE_RUNS;
  const pageInfo = runs.data?.pageInfo ?? EMPTY_PAGE_INFO;
  const asOf = runs.data?.asOf ?? null;
  const loading = runs.loading;
  const error = runs.error;

  const applyQuery = (
    next: CreativeRunListQuery,
    historyMode: "none" | "push" | "replace",
    nextCursorStack: readonly string[] = [],
  ) => {
    setSearch(next.search);
    setOutcome(next.outcome);
    setApplied(next);
    setCursorStack(nextCursorStack);
    if (historyMode !== "none") {
      window.history[historyMode === "push" ? "pushState" : "replaceState"](
        { cursorStack: nextCursorStack } satisfies RunListHistoryState,
        "",
        `${window.location.pathname}?${creativeRunListParams(next)}`,
      );
    }
  };

  useEffect(() => {
    const restore = (historyMode: "none" | "replace") => {
      const params = new URLSearchParams(window.location.search);
      const stack = restoredCursorStack();
      applyQuery(
        {
          search: params.get("search") ?? "",
          outcome: params.get("executionOutcome") ?? "all",
          cursor: stack.length === 0 ? undefined : params.get("cursor") ?? undefined,
        },
        historyMode,
        stack,
      );
    };
    restore("replace");
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // INTENT: 只在挂载时读一次地址栏并注册 popstate；applyQuery 每次渲染都是新函数，
    //         进依赖会让监听器反复重装。
  }, []);

  function apply(nextCursor?: string, nextCursorStack: readonly string[] = []) {
    applyQuery({ search, outcome, cursor: nextCursor }, "push", nextCursorStack);
  }

  function goToPage(direction: "next" | "previous") {
    if (direction === "next") {
      apply(pageInfo.endCursor ?? undefined, [...cursorStack, applied.cursor ?? ""]);
      return;
    }
    const previous = cursorStack.slice(0, -1);
    apply(cursorStack.at(-1) || undefined, previous);
  }

  if (!permissions.read) return denied();
  const filtered = Boolean(search || outcome !== "all");
  return (
    <section aria-labelledby="creative-runs-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div><h2 className="sr-only" id="creative-runs-title">{t("Creative Runs")}</h2><p className="max-w-2xl text-sm text-[var(--ad-text-muted)]">{t("Generate assets, choose where to use them, and verify delivery.")}</p></div>
        <form className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_180px_auto]" onSubmit={(event) => { event.preventDefault(); apply(); }}>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search")}<input className={`${fieldClass} mt-1`} onChange={(event) => setSearch(event.target.value)} placeholder={t("Run, title or purpose")} value={search} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Outcome")}<select className={`${fieldClass} mt-1`} onChange={(event) => setOutcome(event.target.value)} value={outcome}>{["all", "pending", "running", "succeeded", "partially_succeeded", "failed", "cancelled"].map((value) => <option key={value}>{t(value.replaceAll("_", " "))}</option>)}</select></label>
          <WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>
        </form>
      </div>
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void runs.refresh()} type="button">{t("Retry")}</button></div> : null}
      <div className="mt-6">{loading && items.length === 0 ? <LoadingWorkspace label="Loading Creative Run facts" /> : items.length === 0 ? error ? null : <EmptyWorkspace filtered={filtered} onClear={() => applyQuery({ search: "", outcome: "all" }, "push")} /> : <div className="grid gap-3">{items.map((run) => <Link className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 sm:grid-cols-[1fr_auto]" href={`/admin/creative/runs/${run.id}`} key={run.id}><div><div className="flex flex-wrap items-center gap-2"><strong>{t(run.purpose)}</strong><StatusBadge value={run.executionOutcome} />{run.purpose === "model_eval" ? <StatusBadge value={run.reviewState} /> : null}<StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{run.target.type === "none" ? t("Choose an asset destination") : `${run.target.type}:${run.target.id}`} · {t(run.workflowStage)}  {t("· owner")} {run.ownerId ?? t("unassigned")}</p><div className="mt-3 flex flex-wrap gap-3 text-xs tabular-nums"><span>{run.counts.generated}/{run.counts.total}  {t("generated")}</span><span>{run.counts.failed}  {t("failed")}</span><span>{run.counts.placed}  {t("placed")}</span></div></div><span className="self-center text-xs text-[var(--ad-text-muted)]">{t("Open operator flow →")}</span></Link>)}</div>}</div>
      <div className="mt-4">
        <Pagination
          detail={asOf ? t("Fresh as of {time}", { time: formatDateTime(asOf, locale) }) : t("Not loaded yet")}
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          // 「上一页」走本地走过的游标栈，不是 pageInfo.hasPreviousPage —— 反向游标缺席只说明
          // 这个 operation 还是单向的，不代表运营在第一页。
          hasPrevious={cursorStack.length > 0}
          loading={loading}
          onNext={() => goToPage("next")}
          onPrevious={() => goToPage("previous")}
          page={cursorStack.length + 1}
          pageSize={CREATIVE_RUN_PAGE_SIZE}
          rowCount={items.length}
          totalCount={pageInfo.totalCount ?? null}
        />
      </div>
    </section>
  );
}

function AssetViewer({ run, selected, onSelect }: { run: CreativeRunDetail; selected: number; onSelect: (index: number) => void }) {
  const { t } = useAdminI18n();
  const item = run.items[selected];
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onSelect((selected + (event.key === "ArrowRight" ? 1 : -1) + run.items.length) % run.items.length);
  };
  if (!item) return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]" onKeyDown={move} tabIndex={0} aria-label={t("Creative asset viewer. Use left and right arrow keys to move between items.")}><div className="min-h-80 overflow-hidden rounded-xl border border-[var(--ad-border)] bg-black/[0.04]">{item.asset ? (
    // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
    <img alt={t("Creative item {ordinal}", { ordinal: item.ordinal + 1 })} className="max-h-[70vh] w-full object-contain" src={item.asset.url} />
  ) : <div className="grid min-h-80 place-items-center text-[var(--ad-text-muted)]"><ImageIcon className="h-8 w-8" /><span>{t(item.executionState === "unknown" ? "Generation outcome needs confirmation" : "No valid artifact")}</span></div>}</div><aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex flex-wrap gap-2"><StatusBadge value={item.executionState === "unknown" ? "Needs confirmation" : item.executionState} tone={item.executionState === "unknown" ? "warn" : undefined} />{item.executionState === "unknown" ? <StatusBadge value="Retry unavailable" tone="warn" /> : <><StatusBadge value={item.status} /><StatusBadge value={item.retryability} /></>}</div>{item.executionState === "unknown" ? <div className="mt-4 text-sm" role="status"><p>{t("The provider outcome is unknown. Confirm the result in Generation Jobs before retrying or using this item.")}</p>{item.lineage.requestId ? <Link className="mt-3 inline-flex min-h-11 items-center font-semibold underline" href={`/admin/ops/jobs?job=${encodeURIComponent(item.lineage.requestId)}`}>{t("Open generation recovery")}</Link> : null}</div> : null}<dl className="mt-4 space-y-3 text-xs"><div><dt className="text-[var(--ad-text-muted)]">{t("Request / attempt")}</dt><dd className="mt-1 break-all">{item.lineage.requestId ?? t("Unavailable")}<br />{item.lineage.attemptId ?? t("Unavailable")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Provider request / Comfy prompt")}</dt><dd className="mt-1 break-all">{item.lineage.providerRequestId ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt><dd className="mt-1 break-all">{item.asset?.id ?? t("Unavailable")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Placement")}</dt><dd className="mt-1">{item.placement ? t("{slot} · {verification}", { slot: t(item.placement.slot), verification: t(item.placement.verificationState) }) : t("Unplaced")}</dd></div></dl></aside></div>;
}

function ReviewContext({ run, itemIndex }: { run: CreativeRunDetail; itemIndex: number }) {
  const { t } = useAdminI18n();
  const item = run.items[itemIndex];
  return (
    <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="creative-review-context-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Decision context")}</p>
          <h3 className="mt-1 font-semibold" id="creative-review-context-title">{t("Generation brief")}</h3>
        </div>
        <p className="text-xs text-[var(--ad-text-muted)]">{t("The brief and generation route are frozen evidence for this Run.")}</p>
      </div>
      <blockquote className="mt-4 border-l-2 border-[var(--ad-ink)] pl-4 text-sm leading-6">{run.reviewContext.brief}</blockquote>
      {run.reviewContext.negativePrompt ? (
        <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
          <strong className="text-[var(--ad-ink)]">{t("Applied exclusions")}:</strong>{" "}
          {run.reviewContext.negativePrompt}
        </p>
      ) : null}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
        <div><dt className="text-[var(--ad-text-muted)]">{t("Intended use")}</dt><dd className="mt-1 font-medium">{t(run.purpose.replaceAll("_", " "))}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Canvas")}</dt><dd className="mt-1 font-medium">{run.reviewContext.orientation ?? t("Unavailable")}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Image route")}</dt><dd className="mt-1 font-medium">{t(run.reviewContext.profile.label ?? run.reviewContext.profile.key ?? "Unavailable")}{run.reviewContext.profile.version ? ` · v${run.reviewContext.profile.version}` : ""}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Recipe")}</dt><dd className="mt-1 font-medium">{t(run.reviewContext.recipe.label ?? run.reviewContext.recipe.key ?? "Unavailable")}{run.reviewContext.recipe.version ? ` · v${run.reviewContext.recipe.version}` : ""}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Reference images")}</dt><dd className="mt-1 font-medium">{run.reviewContext.referenceAssetCount}</dd></div>
      </dl>
      {item?.direction ? (
        <div className="mt-4 rounded-lg bg-black/[0.035] p-3">
          <strong className="text-sm">{item.direction.title}</strong>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{item.direction.scenePrompt}</p>
          <p className="mt-2 text-xs">{item.direction.setting} · {item.direction.mood} · {item.direction.camera} · {item.direction.lighting}</p>
        </div>
      ) : null}
    </section>
  );
}

function ModelEvaluationForm({ run, itemIndex, permissions, reload, onAdvance }: {
  run: CreativeRunDetail;
  itemIndex: number;
  permissions: Permissions;
  reload: () => Promise<void>;
  onAdvance?: (index: number) => void;
}) {
  const { t } = useAdminI18n();
  const item = run.items[itemIndex];
  const [reason, setReason] = useState("");
  const [score, setScore] = useState("");
  const [identityConsistency, setIdentityConsistency] = useState<"passed" | "failed">("passed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  if (!item) return null;
  const decide = async (decision: "approved" | "rejected") => {
    const numericScore = Number(score);
    if (!score.trim() || !Number.isInteger(numericScore) || numericScore < 0 || numericScore > 100 || reason.trim().length < 3) return;
    const body = { entityVersion: run.version, decision, identityConsistency, score: numericScore, reason: reason.trim() };
    const requestSignature = JSON.stringify({
      runId: run.id,
      itemId: item.id,
      body,
    });
    const idempotencyKey = idempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    idempotencyKeys.current[requestSignature] = idempotencyKey;
    setBusy(true); setError(null); setWarning(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/items/${item.id}/decisions`, {
        method: "POST",
        idempotencyKey,
        body,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review decision failed");
      setBusy(false);
      return;
    }
    try {
      await reload();
      delete idempotencyKeys.current[requestSignature];
      setReason("");
      setScore("");
      {
        const nextUnreviewedIndex = run.items.findIndex(
          (candidate, index) => index > itemIndex && candidate.review === null,
        );
        const wrappedUnreviewedIndex = nextUnreviewedIndex >= 0
          ? nextUnreviewedIndex
          : run.items.findIndex(
              (candidate, index) => index < itemIndex && candidate.review === null,
            );
        if (wrappedUnreviewedIndex >= 0) {
          onAdvance?.(wrappedUnreviewedIndex);
        }
      }
    } catch (cause) {
      setWarning(committedProjectionWarning("Review decision", cause));
    }
    finally { setBusy(false); }
  };
  const validScore = score.trim().length > 0 && Number.isInteger(Number(score)) && Number(score) >= 0 && Number(score) <= 100;
  if (item.review) return null;
  return (
    <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="font-semibold">{t("Model evaluation")}</h3>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Score identity match against the sealed Character references. Every evaluation sample requires an explicit pass or fail and a 0–100 score.")}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[120px_180px_1fr]">
        <label className="text-xs font-semibold">{t("Identity match score")}<input className={`${fieldClass} mt-1`} max={100} min={0} onChange={(event) => setScore(event.target.value)} step={1} type="number" value={score} /></label>
        <label className="text-xs font-semibold">{t("Identity consistency")}<select className={`${fieldClass} mt-1`} onChange={(event) => setIdentityConsistency(event.target.value as "passed" | "failed")} value={identityConsistency}><option value="passed">{t("Passed")}</option><option value="failed">{t("Failed")}</option></select></label>
        <label className="text-xs font-semibold">{t("Evidence and reason")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
      </div>
      {error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      {warning ? <p className="mt-3 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}
      <div className="mt-4 flex gap-2">
        <WorkspaceButton disabled={!permissions.review || !item.asset || busy || !validScore || reason.trim().length < 3 || identityConsistency !== "passed"} onClick={() => void decide("approved")} tone="primary"><Check className="h-4 w-4" />{t("Approve")}</WorkspaceButton>
        <WorkspaceButton disabled={!permissions.review || !item.asset || busy || !validScore || reason.trim().length < 3} onClick={() => void decide("rejected")} tone="danger"><X className="h-4 w-4" />{t("Reject")}</WorkspaceButton>
      </div>
    </section>
  );
}

function HistoricalDecision({ run, itemIndex }: { run: CreativeRunDetail; itemIndex: number }) {
  const { t } = useAdminI18n();
  const decision = run.items[itemIndex]?.review;
  if (!decision) return null;
  return <details className="mt-4 rounded-xl border border-[var(--ad-border)] p-4"><summary className="cursor-pointer text-sm font-semibold">{t("Historical decision")}</summary><p className="mt-3 text-sm">{t(decision.decision)} · {t(decision.identityConsistency)}{decision.score !== null ? ` · ${decision.score}/100` : ""}</p><p className="mt-2 text-sm text-[var(--ad-text-muted)]">{decision.reason}</p></details>;
}

function PlacementForm({ run, itemIndex, permissions, reload }: { run: CreativeRunDetail; itemIndex: number; permissions: Permissions; reload: () => Promise<void> }) {
  const { t } = useAdminI18n();
  const item = run.items[itemIndex];
  const slot = "campaign";
  const placementSupported = run.purpose === "campaign";
  const [targetType] = useState(run.target.type === "none" ? "campaign" : run.target.type);
  const [targetId, setTargetId] = useState(run.target.type === "none" ? "" : run.target.id);
  const [eyebrow, setEyebrow] = useState("");
  const [campaignTitle, setCampaignTitle] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [campaignHref, setCampaignHref] = useState("");
  const [stageReason, setStageReason] = useState("");
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  const hasPartialCampaignCta = Boolean(ctaLabel.trim()) !==
    Boolean(campaignHref.trim());
  if (!item) return <div className="mt-4"><CollaborationPanel canWrite={permissions.write} targetId={run.id} targetType="creative_run" targetVersion={run.version} /></div>;
  if (item.executionState === "unknown") return null;
  if (!placementSupported) {
    if (run.purpose === "model_eval") return null;
    const summary = nonCampaignAssetSummary(Boolean(item.asset));
    const href = run.target.type === "character"
      ? `/admin/characters/${encodeURIComponent(run.target.id)}?tab=${run.purpose === "character_video" ? "video" : "assets"}`
      : "/admin/creative/library";
    return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><h3 className="font-semibold">{t(summary.title)}</h3><p className="mt-2 text-sm text-[var(--ad-text-muted)]">{t(summary.description)}</p><Link className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold underline" href={href}>{t(run.target.type === "character" ? "Choose assets in Character workspace" : "Open asset library")}</Link></section>;
  }

  const place = async () => {
    if (!item.asset) return;
    const body = {
      entityVersion: run.version,
      itemId: item.id,
      assetId: item.asset.id,
      slot,
      targetType,
      targetId,
      ...authoredCampaignPlacementCopy({
        eyebrow,
        title: campaignTitle,
        ctaLabel,
        href: campaignHref,
      }),
      reason: stageReason.trim(),
    };
    const requestSignature = JSON.stringify({ action: "stage", runId: run.id, body });
    const idempotencyKey = idempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    idempotencyKeys.current[requestSignature] = idempotencyKey;
    setBusy(true); setError(null); setWarning(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements`, {
        method: "POST",
        idempotencyKey,
        body,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Placement staging failed");
      setBusy(false);
      return;
    }
    try {
      await reload();
      delete idempotencyKeys.current[requestSignature];
      setStageReason("");
    } catch (cause) {
      setWarning(committedProjectionWarning("Placement staging", cause));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    if (!item.placement) return;
    const placement = item.placement;
    const body = {
      entityVersion: run.version,
      reason: "Verify the authoritative distribution slot and atomically activate the staged asset",
    };
    const requestSignature = JSON.stringify({
      action: "verify",
      runId: run.id,
      placementId: placement.id,
      body,
    });
    const idempotencyKey = idempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    idempotencyKeys.current[requestSignature] = idempotencyKey;
    setBusy(true); setError(null); setWarning(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements/${placement.id}/verification`, {
        method: "POST",
        idempotencyKey,
        body,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Placement verification and activation failed");
      setBusy(false);
      return;
    }
    try {
      await reload();
      delete idempotencyKeys.current[requestSignature];
    } catch (cause) {
      setWarning(committedProjectionWarning("Placement activation", cause));
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!item.placement) return;
    const placement = item.placement;
    const body = {
      entityVersion: run.version,
      reason: withdrawalReason.trim(),
    };
    const requestSignature = JSON.stringify({
      action: "withdraw",
      runId: run.id,
      placementId: placement.id,
      body,
    });
    const idempotencyKey = idempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    idempotencyKeys.current[requestSignature] = idempotencyKey;
    setBusy(true); setError(null); setWarning(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements/${placement.id}/withdrawal`, {
        method: "POST",
        idempotencyKey,
        body,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Staged placement withdrawal failed");
      setBusy(false);
      return;
    }
    try {
      await reload();
      delete idempotencyKeys.current[requestSignature];
      setWithdrawalReason("");
    } catch (cause) {
      setWarning(committedProjectionWarning("Placement withdrawal", cause));
    } finally {
      setBusy(false);
    }
  };
  const canWithdrawStagedPlacement = item.placement?.status === "scheduled" &&
    item.placement.verificationState === "verifying";
  return (
    <>
      <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{t("Placement & verification")}</h3>
          {item.placement ? <StatusBadge value={item.placement.verificationState} /> : null}
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
          {t("Staging preserves the current live image. Verification activates this candidate only after the runtime surface renders the selected asset.")}
        </p>
        {!item.placement ? (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Destination")}
                <input className={`${fieldClass} mt-1`} readOnly value={t("Campaign collection")} />
              </label>
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Campaign destination key")}
                <input className={`${fieldClass} mt-1`} onChange={(event) => setTargetId(event.target.value)} value={targetId} />
              </label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Campaign eyebrow")}
                <input className={`${fieldClass} mt-1`} maxLength={80} onChange={(event) => setEyebrow(event.target.value)} value={eyebrow} />
              </label>
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Campaign title")}
                <input className={`${fieldClass} mt-1`} maxLength={120} onChange={(event) => setCampaignTitle(event.target.value)} value={campaignTitle} />
              </label>
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Campaign CTA label")}
                <input className={`${fieldClass} mt-1`} maxLength={60} onChange={(event) => setCtaLabel(event.target.value)} value={ctaLabel} />
              </label>
              <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Campaign CTA href")}
                <input className={`${fieldClass} mt-1`} maxLength={512} onChange={(event) => setCampaignHref(event.target.value)} value={campaignHref} />
              </label>
            </div>
            <p className={cn("mt-2 text-xs", hasPartialCampaignCta ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text-muted)]")}>
              {t("Add both a CTA label and destination, or leave both blank.")}
            </p>
            <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Staging reason")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => setStageReason(event.target.value)}
                placeholder={t("Explain why this asset should become the campaign candidate")}
                value={stageReason}
              />
            </label>
          </>
        ) : null}
        {canWithdrawStagedPlacement ? (
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Withdrawal reason")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setWithdrawalReason(event.target.value)}
              placeholder={t("Explain why the staged candidate must be withdrawn")}
              value={withdrawalReason}
            />
          </label>
        ) : null}
        {error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        {warning ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!item.placement ? (
            <WorkspaceButton
              disabled={!permissions.place || !item.asset || !["generated", "approved", "published"].includes(item.status) || busy || !targetId.trim() || !eyebrow.trim() || !campaignTitle.trim() || hasPartialCampaignCta || stageReason.trim().length < 3}
              onClick={() => void place()}
              tone="primary"
            >
              <Send className="h-4 w-4" /> {t("Stage campaign candidate")}
            </WorkspaceButton>
          ) : (
            <WorkspaceButton
              disabled={!permissions.place || item.placement.verificationState === "passed" || busy}
              onClick={() => void verify()}
            >
              <RefreshCcw className="h-4 w-4" /> {t("Verify & activate")}
            </WorkspaceButton>
          )}
          {canWithdrawStagedPlacement ? (
            <WorkspaceButton
              disabled={!permissions.place || busy || withdrawalReason.trim().length < 3}
              onClick={() => void withdraw()}
              tone="danger"
            >
              <X className="h-4 w-4" /> {t("Withdraw staged placement")}
            </WorkspaceButton>
          ) : null}
        </div>
        {!permissions.place ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("A Creative publisher permission is required for activation.")}</p> : null}
      </section>
      <div className="mt-4">
        <CollaborationPanel canWrite={permissions.write} targetId={run.id} targetType="creative_run" targetVersion={run.version} />
      </div>
    </>
  );
}

function IncidentAttachment({ run, permissions, reload }: { run: CreativeRunDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const { t } = useAdminI18n();
  const [incidentId, setIncidentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const attach = async () => {
    setBusy(true); setError(null); setWarning(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/commands/attach-incident`, {
        method: "POST",
        idempotencyKey,
        body: {
          entityVersion: run.version,
          incidentId: incidentId.trim(),
          reason: "Attach failed Creative Attempts to the diagnosed platform Incident",
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Incident attachment failed");
      setBusy(false);
      return;
    }
    try {
      await reload();
      setIdempotencyKey(crypto.randomUUID());
      setIncidentId("");
    } catch (cause) {
      setWarning(committedProjectionWarning("Incident attachment", cause));
    } finally {
      setBusy(false);
    }
  };
  return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><h3 className="font-semibold">{t("Related Incidents")}</h3><div className="mt-2 flex flex-wrap gap-2">{run.relatedIncidentIds?.length ? run.relatedIncidentIds.map((id) => <Link className="text-sm underline" href={`/admin/ops/incidents/${id}`} key={id}>{id}</Link>) : <span className="text-xs text-[var(--ad-text-muted)]">{t("No correlated Incident")}</span>}</div>{permissions.manageIncident ? <div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="flex-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Active Incident ID")}<input className={`${fieldClass} mt-1`} onChange={(event) => setIncidentId(event.target.value)} value={incidentId} /></label><WorkspaceButton disabled={busy || !incidentId.trim()} onClick={() => void attach()}>{t("Attach failed Attempts")}</WorkspaceButton></div> : null}{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}{warning ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}</section>;
}

function RunDetail({
  id,
  actorId,
  permissions,
}: {
  id: string;
  actorId: string;
  permissions: Permissions;
}) {
  const { t } = useAdminI18n();
  const fetchRun = useCallback(
    () =>
      adminV2Request(`/api/v2/admin/creative/runs/${id}`, {
        schema: creativeRunDetailSchema,
      }),
    [id],
  );
  // SPEC: Run 投影是这一屏唯一的取数：前台取数、生成中轮询、提交后回读共用一份状态。
  // INTENT: 原来是 run/loading/error/backgroundRefreshWarning 四个 useState 加一个手写
  //         latest-request 门控，由 load(background, propagateError) 两个布尔开关分派四
  //         种行为。"后台失败只挂旁注、前台失败才换成报错"本就是 useAuthorityResource
  //         的 error/refreshError 之分，没有理由在这里再实现一遍。
  // INVARIANT: RunDetail 由父组件按 `${actorId}:${id}` 加 key，换 Run 一定是重新挂载，
  //            所以这里不需要再防跨 id 的迟到响应。
  const runResource = useAuthorityResource(
    { key: id, enabled: permissions.read, load: fetchRun },
    {
      // SPEC: 生成中的 Run 每 4s 刷新一次，失败退避到 8s。
      pollWhile: ({ data, error: refreshFailure }) =>
        data && (["pending", "running"].includes(data.executionOutcome) || data.items.some((item) => item.executionState === "unknown"))
          ? refreshFailure === null ? 4_000 : 8_000
          : null,
    },
  );
  const run = runResource.data;
  const loading = runResource.loading;
  const [selected, setSelected] = useState(0);
  // SPEC: error 只承载写入侧（重试命令）的失败；取数失败归 runResource.error。
  // INTENT: 两者曾共用一个 useState，于是一次成功的后台刷新会把"重试命令失败"的结论
  //         也一并抹掉。分开后各自的清除时机才说得清。
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [retrySubmitting, setRetrySubmitting] = useState(false);
  const [retryProjectionRefreshing, setRetryProjectionRefreshing] =
    useState(false);
  const [retryCommand, setRetryCommand] =
    useState<CreativeRetryCommandState | null>(null);
  const retryResumeOnMount = useRef(false);
  const [retryIdempotencyKey, setRetryIdempotencyKey] = useState(
    () => crypto.randomUUID(),
  );
  const retryCommandRef =
    useRef<CreativeRetryCommandState | null>(null);
  const retrySubmissionLock = useRef(false);
  const retryCommandLocksNewIntent = Boolean(
    retryCommand &&
    retryCommand.status !== "submission_unknown" &&
    retryCommand.status !== "failed" &&
    retryCommand.status !== "cancelled",
  );
  const retrying =
    retrySubmitting ||
    retryCommandLocksNewIntent;
  // SPEC: 提交成功后回读投影；读失败必须抛给调用方，由调用方决定挂什么警告。
  // INTENT: 不能走 refresh()——那是前台取数，会把整屏换成 loading，而且它把失败吞成
  //         error 状态而不是抛出，调用方就写不出"命令已提交但投影没跟上"的那句话了。
  const { setData: setRunProjection } = runResource;
  const reloadAfterCommit = useCallback(async () => {
    setRunProjection(await fetchRun());
  }, [fetchRun, setRunProjection]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const restored = readCreativeRetryCommand(id, actorId);
      if (!restored) return;
      retryCommandRef.current = restored;
      retryResumeOnMount.current = Boolean(
        restored.commandId === null &&
        (restored.status === "submitting" ||
          restored.status === "submission_unknown"),
      );
      setRetryCommand(restored);
      setRetryIdempotencyKey(restored.idempotencyKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actorId, id]);
  const submitRetryIntent = useCallback(async (intent: {
    readonly idempotencyKey: string;
    readonly entityVersion: number;
  }) => {
    if (retrySubmissionLock.current) return;
    retrySubmissionLock.current = true;
    setRetrySubmitting(true);
    setError(null);
    setWarning(null);
    const prior = retryCommandRef.current;
    const submitting: CreativeRetryCommandState = {
      actorId,
      createdAt:
        prior?.actorId === actorId &&
        prior.idempotencyKey === intent.idempotencyKey
          ? prior.createdAt
          : Date.now(),
      commandId: null,
      idempotencyKey: intent.idempotencyKey,
      entityVersion: intent.entityVersion,
      verificationDeepLink: null,
      status: "submitting",
    };
    retryCommandRef.current = submitting;
    setRetryCommand(submitting);
    setRetryIdempotencyKey(intent.idempotencyKey);
    persistCreativeRetryCommand(id, actorId, submitting);
    try {
      const mutation = creativeRetryFailedMutation(
        id,
        intent.entityVersion,
        intent.idempotencyKey,
      );
      const accepted = await adminV2Operation(mutation.operationId, mutation.options);
      const next: CreativeRetryCommandState = {
        actorId,
        createdAt: submitting.createdAt,
        commandId: accepted.commandId,
        idempotencyKey: intent.idempotencyKey,
        entityVersion: intent.entityVersion,
        verificationDeepLink: accepted.verificationDeepLink,
        status: accepted.status,
      };
      retryCommandRef.current = next;
      setRetryCommand(next);
      persistCreativeRetryCommand(id, actorId, next);
    } catch (cause) {
      if (isDefinitiveAdminMutationRejection(cause)) {
        persistCreativeRetryCommand(id, actorId, null);
        retryCommandRef.current = null;
        setRetryCommand(null);
        setRetryIdempotencyKey(crypto.randomUUID());
        setError(cause.message);
      } else {
        const unknown: CreativeRetryCommandState = {
          ...submitting,
          status: "submission_unknown",
          error:
            cause instanceof Error
              ? cause.message
              : "Retry submission outcome is unknown",
        };
        retryCommandRef.current = unknown;
        setRetryCommand(unknown);
        persistCreativeRetryCommand(id, actorId, unknown);
        setError(
          "Retry submission outcome is unknown. Resume the same submission; its idempotency key will be reused.",
        );
      }
    } finally {
      retrySubmissionLock.current = false;
      setRetrySubmitting(false);
    }
  }, [actorId, id]);
  const activeRetryCommandId =
    retryCommand?.commandId &&
    (retryCommand.status === "accepted" ||
      retryCommand.status === "running" ||
      retryCommand.status === "verifying")
      ? retryCommand.commandId
      : null;
  // SPEC: 重试命令状态每 1.5s 拉一次；读不到状态退避到 3s；命令落终态即停。
  // INTENT: 这是状态机不是取数——每种状态各有副作用（落盘、刷新投影、解锁写入），
  //         所以走 usePollingTask 让 task 直接返回下一次间隔，而不是自己 setTimeout。
  const pollRetryCommand = useCallback<PollingTask>(async (context) => {
      if (!activeRetryCommandId) return null;
      try {
        const command = await adminV2Request(
          `/api/v2/admin/commands/${encodeURIComponent(activeRetryCommandId)}`,
          { schema: adminCommandStatusSchema },
        );
        if (context.cancelled) return null;
        const current = retryCommandRef.current;
        if (
          !current ||
          current.commandId !== activeRetryCommandId
        ) {
          return null;
        }
        const next: CreativeRetryCommandState = {
          ...current,
          status: command.status,
          ...(command.error === undefined
            ? {}
            : { error: command.error }),
        };
        if (command.status === "succeeded") {
          persistCreativeRetryCommand(id, actorId, next);
          setError(null);
          try {
            await reloadAfterCommit();
          } catch (cause) {
            if (!context.cancelled) {
              retryCommandRef.current = next;
              setRetryCommand(next);
              setWarning(
                `Retry command succeeded, but the latest projection could not be refreshed${
                  cause instanceof Error ? `: ${cause.message}` : ""
                }. Refresh the projection before starting another retry.`,
              );
            }
            return null;
          }
          if (context.cancelled) return null;
          persistCreativeRetryCommand(id, actorId, null);
          retryCommandRef.current = null;
          setRetryCommand(null);
          setRetryIdempotencyKey(crypto.randomUUID());
          setWarning(null);
          return null;
        }
        retryCommandRef.current = next;
        setRetryCommand(next);
        persistCreativeRetryCommand(id, actorId, next);
        if (
          command.status === "failed" ||
          command.status === "cancelled"
        ) {
          setError(creativeRetryFailureMessage(command.error));
          return null;
        }
        return 1_500;
      } catch (cause) {
        if (context.cancelled) return null;
        setWarning(
          `Retry command ${activeRetryCommandId} is still pending, but its latest status could not be loaded${
            cause instanceof Error ? `: ${cause.message}` : ""
          }.`,
        );
        return 3_000;
      }
  }, [activeRetryCommandId, actorId, id, reloadAfterCommit]);
  usePollingTask(activeRetryCommandId ? pollRetryCommand : null, 0);
  useEffect(() => {
    if (
      !run ||
      !permissions.write ||
      !retryResumeOnMount.current ||
      !retryCommand ||
      retryCommand.commandId !== null ||
      (retryCommand.status !== "submitting" &&
        retryCommand.status !== "submission_unknown")
    ) {
      return;
    }
    retryResumeOnMount.current = false;
    void submitRetryIntent({
      idempotencyKey: retryCommand.idempotencyKey,
      entityVersion: retryCommand.entityVersion,
    });
  }, [permissions.write, retryCommand, run, submitRetryIntent]);
  const retryFailed = async () => {
    if (!run || retrying || retrySubmissionLock.current) return;
    if (run.items.some((item) => item.executionState === "unknown") && retryCommand?.status !== "submission_unknown") return;
    let idempotencyKey = retryIdempotencyKey;
    let entityVersion = run.version;
    if (retryCommand?.status === "submission_unknown") {
      idempotencyKey = retryCommand.idempotencyKey;
      entityVersion = retryCommand.entityVersion;
    } else if (
      retryCommand?.status === "failed" ||
      retryCommand?.status === "cancelled"
    ) {
      idempotencyKey = crypto.randomUUID();
    }
    await submitRetryIntent({ idempotencyKey, entityVersion });
  };
  const refreshRetryProjection = async () => {
    if (
      retryCommand?.status !== "succeeded" ||
      retryProjectionRefreshing
    ) {
      return;
    }
    setRetryProjectionRefreshing(true);
    setError(null);
    setWarning(null);
    try {
      await reloadAfterCommit();
      persistCreativeRetryCommand(id, actorId, null);
      retryCommandRef.current = null;
      setRetryCommand(null);
      setRetryIdempotencyKey(crypto.randomUUID());
    } catch (cause) {
      setWarning(
        `The retry command is verified, but the latest projection still could not be refreshed${
          cause instanceof Error ? `: ${cause.message}` : ""
        }.`,
      );
    } finally {
      setRetryProjectionRefreshing(false);
    }
  };
  if (!permissions.read) return denied();
  const shownError = runResource.error ?? error;
  const backgroundRefreshWarning = runResource.refreshError
    ? `Automatic refresh was delayed: ${runResource.refreshError}. Retrying in the background.`
    : null;
  if (loading && !run) return <LoadingWorkspace label="Loading Creative Run lineage and outcomes" />;
  if (!run) return <section className="rounded-xl bg-[var(--ad-red-bg)] p-5" role="alert">{shownError ?? t("Creative Run not found")} <button className="ml-2 underline" onClick={() => void runResource.refresh()} type="button">{t("Retry")}</button></section>;
  const unknownCount = run.items.filter((item) => item.executionState === "unknown").length;
  const retryCount = run.retryEligibility.eligibleCount;
  const selectedItemId = run.items[selected]?.id ?? `missing-${selected}`;
  const retryFailedTerminal =
    retryCommand?.status === "failed" ||
    retryCommand?.status === "cancelled";
  const retrySubmissionUnknown =
    retryCommand?.status === "submission_unknown";
  const retryProjectionPending =
    retryCommand?.status === "succeeded";
  const retryBusy =
    retrySubmitting ||
    retryCommand?.status === "submitting" ||
    retryCommand?.status === "accepted" ||
    retryCommand?.status === "running" ||
    retryCommand?.status === "verifying";
  const retryLabel =
    retrySubmitting || retryCommand?.status === "submitting"
    ? t("Submitting retry…")
    : retryBusy
      ? t("Retry in progress")
      : retryProjectionPending
        ? t("Retry completed")
        : retrySubmissionUnknown
          ? t("Resume retry submission")
          : retryFailedTerminal
            ? t("Retry {count} again", { count: retryCount })
            : t("Retry {count} eligible failed", { count: retryCount });
  const retryStatusDescription = retryFailedTerminal
    ? "Fix the reported cause, then choose Retry again to create a new command."
    : retrySubmissionUnknown
      ? "The response was lost or invalid. Resume this submission to reuse the same idempotency key."
      : retryProjectionPending
        ? "The command is verified. Refresh the Run projection before starting another retry."
        : retryCommand?.status === "submitting"
          ? "The intent is saved locally before submission so a lost response can be replayed safely."
          : "Accepted by the control plane. This workspace will refresh after verification succeeds.";
  const retryCommandStatus = retryCommand ? (
    <div
      aria-live="polite"
      className={cn(
        "mt-4 flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
        retryFailedTerminal && "bg-[var(--ad-red-bg)]",
        retrySubmissionUnknown && "bg-[var(--ad-yellow-bg)]",
        !retryFailedTerminal &&
          !retrySubmissionUnknown &&
          "bg-[var(--ad-surface)]",
      )}
      role={
        retryFailedTerminal || retrySubmissionUnknown
          ? "alert"
          : "status"
      }
    >
      <div>
        <span className="font-medium">{t("Retry command")}</span>{" "}
        <StatusBadge
          value={
            retrySubmissionUnknown
              ? "outcome unknown"
              : retryCommand.status
          }
        />
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          {retryStatusDescription}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {retryCommand.verificationDeepLink ? (
          <Link
            className="min-h-11 content-center text-sm font-medium underline underline-offset-4"
            href={retryCommand.verificationDeepLink}
          >

            {t("Open audit trail")}
          </Link>
        ) : null}
        {retryProjectionPending ? (
          <WorkspaceButton
            disabled={retryProjectionRefreshing}
            onClick={() => void refreshRetryProjection()}
          >
            <RefreshCcw
              className={cn(
                "h-4 w-4",
                retryProjectionRefreshing && "animate-spin",
              )}
            />
            {retryProjectionRefreshing
              ? t("Refreshing…")
              : t("Refresh projection")}
          </WorkspaceButton>
        ) : null}
      </div>
    </div>
  ) : null;
  return <section aria-labelledby="creative-run-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/creative/runs"><ArrowLeft className="h-4 w-4" />  {t("Creative Runs")}</Link><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Creative Run ·")} {run.id}</p><h2 className="mt-1 text-2xl font-semibold" id="creative-run-title">{run.title}</h2><div className="mt-2 flex flex-wrap gap-2"><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Execution")}</span><StatusBadge value={unknownCount > 0 ? "Needs confirmation" : run.executionOutcome} tone={unknownCount > 0 ? "warn" : undefined} /></span>{run.purpose === "model_eval" ? <span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Model evaluation")}</span><StatusBadge value={run.reviewState} /></span> : null}<span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Deployment")}</span><StatusBadge value={run.deploymentState} /></span><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Verification")}</span><StatusBadge value={run.verificationState} /></span></div></div><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={loading} onClick={() => void runResource.refresh()}><RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} /> {loading ? t("Refreshing…") : t("Refresh")}</WorkspaceButton><WorkspaceButton aria-busy={retryBusy} disabled={!permissions.write || ((retryCount === 0 || unknownCount > 0) && !retrySubmissionUnknown) || retrying} onClick={() => void retryFailed()}><RotateCcw className={cn("h-4 w-4", retryBusy && "animate-spin")} /> {retryLabel}</WorkspaceButton></div></div>{retryCommandStatus}{unknownCount > 0 ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{t("{count} item(s) need confirmation. These are not confirmed failures; retry is unavailable until recovery is complete.", { count: unknownCount })}</p> : null}<IncidentAttachment permissions={permissions} reload={reloadAfterCommit} run={run} /><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">{(run.purpose === "model_eval" ? ["generated", "failed", "reviewed", "approved"] as const : ["generated", "failed", "placed"] as const).map((key) => <div className="rounded-lg bg-[var(--ad-surface)] p-3" key={key}><p className="text-xs capitalize text-[var(--ad-text-muted)]">{t(key)}</p><p className="mt-1 text-xl font-semibold tabular-nums">{run.counts[key]}<span className="text-xs font-normal text-[var(--ad-text-muted)]"> / {run.counts.total}</span></p></div>)}</div>{shownError ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{shownError}</p> : null}{backgroundRefreshWarning ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{backgroundRefreshWarning}</p> : null}{warning ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}<ReviewContext itemIndex={selected} run={run} /><div className="mt-5 flex gap-2 overflow-x-auto pb-2" aria-label={t("Creative items")}>{run.items.map((item, index) => <button aria-pressed={selected === index} className={cn("min-h-11 min-w-28 rounded-md border px-3 text-left text-xs focus-visible:outline focus-visible:outline-2", selected === index ? "border-[var(--ad-ink)] bg-black/[0.04]" : "border-[var(--ad-border)]")} key={item.id} onClick={() => setSelected(index)} type="button">{t("Item")} {item.ordinal + 1}<br /><span className="text-[var(--ad-text-muted)]">{t(item.executionState === "unknown" ? "Needs confirmation" : item.executionState.replaceAll("_", " "))}</span></button>)}</div><AssetViewer onSelect={setSelected} run={run} selected={selected} /><HistoricalDecision itemIndex={selected} run={run} />{run.purpose === "model_eval" ? <ModelEvaluationForm itemIndex={selected} key={`evaluation-${selectedItemId}`} onAdvance={setSelected} permissions={permissions} reload={reloadAfterCommit} run={run} /> : null}<PlacementForm itemIndex={selected} key={`placement-${selectedItemId}`} permissions={permissions} reload={reloadAfterCommit} run={run} /></section>;
}

export function CreativeRunWorkspace({
  actorId = "anonymous",
  view,
  permissions,
}: {
  actorId?: string;
  view: AdminSubview;
  permissions: Permissions;
}) {
  return view.kind === "detail"
    ? <RunDetail actorId={actorId} id={view.id} key={`${actorId}:${view.id}`} permissions={permissions} />
    : <RunList permissions={permissions} />;
}
