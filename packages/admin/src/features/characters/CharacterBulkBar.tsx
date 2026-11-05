"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminPermissionKey, CharacterPortfolioItem } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { fieldClass, WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation, adminV2OperationAllowed } from "@/lib/admin-v2-operation";
import { characterAssetPurposeLabel } from "./character-asset-studio-authority";
import {
  BULK_ACTION_LABELS,
  BULK_GENERATION_CHARACTER_LIMIT,
  createBulkExecutor,
  planBulkTasks,
  runBulkTasks,
  type BulkAction,
  type BulkTask,
} from "./character-bulk-operations";

type TagOption = { readonly id: string; readonly label: string };

const STATE_LABELS: Record<BulkTask["state"], string> = {
  queued: "Queued",
  running: "Working",
  succeeded: "Done",
  accepted: "Accepted",
  failed: "Failed",
};

// SPEC: 确认框只显示对象数和名字；不要求键入、不要求原因。不适用的项跳过并说明，不整批拒绝。
export function CharacterBulkBar({
  actorId,
  onClear,
  onSettled,
  permissions,
  selected,
}: {
  actorId: string;
  onClear: () => void;
  onSettled: () => void;
  permissions: ReadonlySet<AdminPermissionKey>;
  selected: readonly CharacterPortfolioItem[];
}) {
  const { t } = useAdminI18n();
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [tasks, setTasks] = useState<readonly BulkTask[]>([]);
  const [lastAction, setLastAction] = useState<BulkAction | null>(null);
  const [running, setRunning] = useState(false);
  const [tags, setTags] = useState<readonly TagOption[] | null>(null);
  const [tagId, setTagId] = useState("");
  const canPublish = adminV2OperationAllowed("POST /api/v2/admin/characters/:id/commands/pause", permissions);
  const canGenerate = adminV2OperationAllowed("POST /api/v2/admin/creative/runs", permissions);
  const canTag = adminV2OperationAllowed("PUT /api/v2/admin/content/characters/:id/tags", permissions) &&
    adminV2OperationAllowed("GET /api/v2/admin/content/tags", permissions);
  const hasSelection = selected.length > 0;

  useEffect(() => {
    if (!hasSelection || !canTag || tags !== null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      adminV2Operation("GET /api/v2/admin/content/tags", { query: "limit=200" })
        .then((result) => {
          if (live) setTags(result.items.map((tag) => ({ id: tag.id, label: tag.label })));
        })
        .catch(() => {
          if (live) setTags([]);
        });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [canTag, hasSelection, tags]);

  const execute = useCallback(
    async (action: BulkAction, batch: readonly BulkTask[], items: readonly CharacterPortfolioItem[]) => {
      setRunning(true);
      setLastAction(action);
      const worker = createBulkExecutor({
        action,
        actorId,
        itemByCharacter: new Map(items.map((item) => [item.characterId, item])),
      });
      const patch = (id: string, next: Partial<BulkTask>) =>
        setTasks((current) => current.map((task) => (task.id === id ? { ...task, ...next } : task)));
      await runBulkTasks(batch, async (task) => {
        patch(task.id, { state: "running", message: null });
        try {
          patch(task.id, { state: await worker(task), attempts: task.attempts + 1 });
        } catch (cause) {
          patch(task.id, {
            state: "failed",
            attempts: task.attempts + 1,
            message: cause instanceof Error ? cause.message : "This item failed.",
          });
        }
      });
      setRunning(false);
      onSettled();
    },
    [actorId, onSettled],
  );

  const open = (action: BulkAction) => {
    const plan = planBulkTasks(action, selected);
    const label = t(BULK_ACTION_LABELS[action.kind]);
    const eligibleNames = selected
      .filter((item) => !plan.skipped.some((skip) => skip.characterId === item.characterId))
      .map((item) => item.name);
    setConfirm({
      title: t("{action}: {count} characters", { action: label, count: plan.characterCount }),
      requireReason: false,
      submitLabel: action.kind === "generate_missing"
        ? t("Create {count} tasks", { count: plan.tasks.length })
        : label,
      summary: (
        <div className="grid gap-2 text-sm">
          {action.kind === "generate_missing" ? (
            <p className="font-semibold">
              {t("This creates {count} generation tasks, one image each. Generation costs real money.", {
                count: plan.tasks.length,
              })}
            </p>
          ) : null}
          <p>{eligibleNames.join(", ")}</p>
          {plan.skipped.length > 0 ? (
            <ul className="text-xs text-[var(--ad-text-muted)]">
              {plan.skipped.map((skip) => (
                <li key={skip.characterId}>
                  {t("Skipped {name}: {reason}", { name: skip.name, reason: t(skip.reason) })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ),
      onSubmit: async () => {
        setConfirm(null);
        setTasks(plan.tasks);
        void execute(action, plan.tasks, selected);
      },
    });
  };

  const failed = useMemo(() => tasks.filter((task) => task.state === "failed"), [tasks]);
  const retry = () => {
    if (!lastAction || failed.length === 0) return;
    const queued = failed.map((task) => ({ ...task, state: "queued" as const, message: null }));
    setTasks((current) => current.map((task) => queued.find((next) => next.id === task.id) ?? task));
    void execute(lastAction, queued, selected);
  };

  const planFor = (action: BulkAction) => planBulkTasks(action, selected);
  const actionButton = (action: BulkAction, allowed: boolean) => {
    const plan = planFor(action);
    const disabled = !allowed || running || plan.tasks.length === 0 || plan.overGenerationLimit;
    const hint = !allowed
      ? t("Your grants do not include this action.")
      : plan.overGenerationLimit
        ? t("Select at most {limit} characters to generate.", { limit: BULK_GENERATION_CHARACTER_LIMIT })
        : plan.tasks.length === 0
          ? t(plan.skipped[0]?.reason ?? "Not available.")
          : undefined;
    return (
      <span key={action.kind} title={hint}>
        <WorkspaceButton disabled={disabled} onClick={() => open(action)}>
          {t(BULK_ACTION_LABELS[action.kind])}
          {plan.skipped.length > 0 && plan.tasks.length > 0 ? ` (${plan.characterCount}/${selected.length})` : ""}
        </WorkspaceButton>
      </span>
    );
  };
  const tag = tags?.find((option) => option.id === tagId) ?? null;

  if (!hasSelection && tasks.length === 0) return null;
  return (
    <section aria-label={t("Bulk actions")} className="sticky bottom-4 z-20 mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 shadow-sm">
      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">{t("{count} selected", { count: selected.length })}</strong>
          {actionButton({ kind: "pause" }, canPublish)}
          {actionButton({ kind: "resume" }, canPublish)}
          {actionButton({ kind: "archive" }, canPublish)}
          {actionButton({ kind: "generate_missing" }, canGenerate)}
          {canTag ? (
            <>
              <label className="min-w-40">
                <span className="sr-only">{t("Tag")}</span>
                <select
                  aria-label={t("Tag")}
                  className={fieldClass}
                  onChange={(event) => setTagId(event.target.value)}
                  value={tagId}
                >
                  <option value="">{t("Choose tag")}</option>
                  {(tags ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              {tag ? actionButton({ kind: "add_tag", tagId: tag.id, tagLabel: tag.label }, true) : null}
              {tag ? actionButton({ kind: "remove_tag", tagId: tag.id, tagLabel: tag.label }, true) : null}
            </>
          ) : null}
          <button className="ml-auto text-sm underline-offset-4 hover:underline" onClick={onClear} type="button">
            {t("Clear selection")}
          </button>
        </div>
      ) : null}
      {tasks.length > 0 ? (
        <div className={hasSelection ? "mt-3 border-t border-[var(--ad-border)] pt-3" : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm">{t("Results")}</strong>
            <div className="flex items-center gap-2">
              {failed.length > 0 && !running ? (
                <WorkspaceButton onClick={retry}>{t("Retry {count} failed", { count: failed.length })}</WorkspaceButton>
              ) : null}
              {!running ? (
                <button className="text-sm underline-offset-4 hover:underline" onClick={() => setTasks([])} type="button">
                  {t("Dismiss")}
                </button>
              ) : null}
            </div>
          </div>
          <ul aria-live="polite" className="mt-2 grid max-h-56 gap-1 overflow-y-auto text-sm">
            {tasks.map((task) => (
              <li className="flex flex-wrap items-baseline gap-x-2" key={task.id}>
                <span className="font-medium">{task.name}</span>
                {task.purpose ? (
                  <span className="text-xs text-[var(--ad-text-muted)]">{t(characterAssetPurposeLabel(task.purpose))}</span>
                ) : null}
                <span className={task.state === "failed" ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text-muted)]"}>
                  {t(STATE_LABELS[task.state])}
                </span>
                {task.message ? <span className="text-xs text-[var(--ad-red-text)]">{t(task.message)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} spec={confirm} /> : null}
    </section>
  );
}
