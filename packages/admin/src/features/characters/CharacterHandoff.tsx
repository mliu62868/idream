"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import type { RunCommittedCharacterMutation } from "./character-workspace-permissions";

type CharacterHandoff = NonNullable<CharacterWorkspaceDetail["handoff"]>;

const DRIFT_LABELS: Record<CharacterHandoff["drift"][number], string> = {
  content: "Character content",
  visual_identity: "Visual identity",
  reference_set: "Reference set",
};

/**
 * SPEC: 还有意义的那条交接。之后已经发布过，它描述的就是过去的事，不再提示。
 * INVARIANT: 只决定显示；发布从不读交接，没有交接也照样能发布。
 */
export function characterActiveHandoff(data: CharacterWorkspaceDetail): CharacterHandoff | null {
  const handoff = data.handoff;
  if (!handoff) return null;
  const publishedSince = data.releases.some(({ release }) =>
    release.publishedAt !== null && release.publishedAt > handoff.createdAt
  );
  return publishedSince ? null : handoff;
}

// INTENT: 人设和身份都没有时「可发布」无从谈起；创作者完成这两样后才提供这个按钮。
export function characterHandoffOffered(data: CharacterWorkspaceDetail) {
  return (
    data.soul.valid &&
    data.serving?.state !== "retired" &&
    !data.visual.readiness.blockers.some(({ code }) => code === "visual_identity_missing")
  );
}

// SPEC: 一键记录创作交接，事实由服务端快照。不创建 Release，不改 Serving，不是发布前置步骤。
export function CharacterHandoffAction({
  canWrite,
  data,
  runCommittedMutation,
}: {
  readonly canWrite: boolean;
  readonly data: CharacterWorkspaceDetail;
  readonly runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!characterHandoffOffered(data)) return null;
  const active = characterActiveHandoff(data);
  const upToDate = active !== null && active.drift.length === 0;

  async function record() {
    setBusy(true);
    setError(null);
    try {
      await runCommittedMutation({
        action: "Mark ready to publish",
        commit: () => adminV2Operation("POST /api/v2/admin/characters/:id/handoffs", {
          path: { id: data.character.id },
          body: {},
        }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not mark ready to publish"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3" data-testid="character-handoff-action">
      {error ? <p className="text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      {upToDate ? (
        <p className="text-xs text-[var(--ad-text-muted)]" role="status">
          {t("Marked ready to publish {time}", { time: format.relativeTime(active.createdAt, data.journey.asOf) })}
        </p>
      ) : (
        <WorkspaceButton disabled={!canWrite || busy} onClick={() => void record()}>
          {t("Mark ready to publish")}
        </WorkspaceButton>
      )}
    </div>
  );
}

// SPEC: 发布面板顶部的一句话事实，从不阻断、不警告。
export function CharacterHandoffNotice({ data }: { readonly data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const handoff = characterActiveHandoff(data);
  if (!handoff) return null;
  return (
    <p className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3 text-sm" data-testid="character-handoff-notice">
      {t("{name} marked this ready to publish {time}", {
        name: handoff.createdByName ?? t("A creator"),
        time: format.relativeTime(handoff.createdAt, data.journey.asOf),
      })}
      {" · "}
      {handoff.drift.length === 0
        ? t("No changes since")
        : t("{count} changes since: {items}", {
            count: handoff.drift.length,
            items: handoff.drift.map((item) => t(DRIFT_LABELS[item])).join(", "),
          })}
      {handoff.note ? <span className="mt-1 block text-[var(--ad-text-muted)]">{handoff.note}</span> : null}
    </p>
  );
}
