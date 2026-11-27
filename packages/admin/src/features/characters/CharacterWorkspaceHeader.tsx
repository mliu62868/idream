"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { ImageIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { CharacterFeaturedToggle } from "@/features/content-merchandising/CharacterFeaturedToggle";
import type { CharacterWorkspaceTab } from "@/features/image-workflow-transport";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { renderCharacterCommandMessage } from "./character-command-copy";
import type { CharacterCommandJournal } from "./character-command-journal";
import { characterLifecycleLabel } from "./character-lifecycle-copy";
import { characterHasNoUnpublishedChanges, characterReleaseOrdinals } from "./character-workspace-format";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";
import { CharacterDuplicateButton } from "./CharacterDuplicateButton";
import { submitWorkspaceServingCommand } from "./release-command";

// SPEC: 角色工作区头部：头像、用户可达状态与草稿两行、快捷动作区、技术状态。
// INVARIANT: 快捷动作走与面板相同的写入通道（journal / runCommittedMutation），
//            写入锁由调用方传入，这里不持有锁，只持有「哪个快捷动作在跑」。
export function CharacterWorkspaceHeader({
  canCreateCharacters,
  data,
  guardedPermissions,
  id,
  journal,
  onError,
  onOpenRelease,
  permissions,
  runCommittedMutation,
  tab,
  writesLocked,
}: {
  canCreateCharacters: boolean;
  data: CharacterWorkspaceDetail;
  guardedPermissions: CharacterWorkspacePermissions;
  id: string;
  journal: CharacterCommandJournal;
  onError: (error: string | null) => void;
  onOpenRelease: () => void;
  permissions: CharacterWorkspacePermissions;
  runCommittedMutation: RunCommittedCharacterMutation;
  tab: CharacterWorkspaceTab;
  writesLocked: boolean;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [quickActionBusy, setQuickActionBusy] = useState<
    "pause" | "resume" | "visibility" | null
  >(null);
  const workspaceName =
    data.preview.draft?.name ?? data.preview.live?.name ?? data.character.name;
  const workspaceImageUrl =
    data.preview.draft?.imageUrl ??
    data.preview.live?.imageUrl ??
    data.character.imageUrl;
  const servingState = data.journey.release.servingState;
  const releaseId = data.journey.release.currentReleaseId;
  const releaseOrdinal = releaseId ? characterReleaseOrdinals(data.releases).get(releaseId) : undefined;
  const servingLabel = characterLifecycleLabel({ state: servingState, currentReleaseId: releaseId });
  const discoveryLabel = servingState === "live" && data.character.visibility === "public" ? "Listed in Explore"
    : servingState === "live" && data.character.visibility === "unlisted" ? "Direct link only"
    : servingState === "live" && data.character.visibility === "private" ? "Private"
    : null;
  const { completed, total } = data.journey.assetPack.draft;
  const draftStatus = characterHasNoUnpublishedChanges(data) && releaseOrdinal
    ? t("Matches release #{version}", { version: releaseOrdinal })
    : data.journey.release.candidateReleaseId
      ? t("Pending publish")
      : releaseId && data.preview.changedFields.length
        ? t("{count} unpublished changes", { count: data.preview.changedFields.length })
        // SPEC: 创作者改了已发布角色只存了新修订时，头部也要说出「待发布修订」（原在概览状态格）。
        : data.journey.release.pendingRevision
          ? t("Revision #{revision} not published", { revision: data.journey.release.pendingRevision.revision })
          : null;
  const quickToggleServing = async (action: "pause" | "resume") => {
    if (!data.serving || quickActionBusy || writesLocked) return;
    setQuickActionBusy(action);
    onError(null);
    try {
      const message = await submitWorkspaceServingCommand(journal, {
        characterId: data.character.id,
        action,
        entityVersion: data.serving.version,
        summary: t(action === "pause" ? "Pause serving" : "Resume serving"),
      });
      if (message) onError(renderCharacterCommandMessage(message, t));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Serving action failed");
    } finally {
      setQuickActionBusy(null);
    }
  };
  const quickToggleVisibility = async () => {
    if (!data.serving || data.serving.state !== "live" || quickActionBusy || writesLocked) return;
    const visibility = data.character.visibility === "unlisted" ? "public" : "unlisted";
    const action = visibility === "public" ? "Show in Explore" : "Hide from Explore";
    setQuickActionBusy("visibility");
    onError(null);
    try {
      await runCommittedMutation({
        action,
        commit: () =>
          adminV2Operation("POST /api/v2/admin/content/characters/:id/visibility", {
            path: { id: data.character.id },
            body: {
              visibility,
              entityVersion: data.serving!.version,
              reason: action,
              confirmation: `${data.character.id}:visibility:${visibility}`,
            },
          }),
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not update Explore visibility");
    } finally {
      setQuickActionBusy(null);
    }
  };
  const hasQuickPublish =
    servingState !== "retired" &&
    tab !== "release" &&
    data.journey.assetPack.draft.completed === data.journey.assetPack.draft.total &&
    (!characterHasNoUnpublishedChanges(data) ||
      Boolean(data.journey.release.candidateReleaseId));
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {workspaceImageUrl ? (
          <Image
            alt={t("{name} primary role portrait", { name: workspaceName })}
            className="h-16 w-16 shrink-0 rounded-lg object-cover"
            height={64}
            loading="eager"
            src={workspaceImageUrl}
            unoptimized
            width={64}
          />
        ) : (
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text-muted)]">
            <ImageIcon aria-hidden="true" className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2
              className="truncate text-xl font-semibold"
              id="character-workspace-title"
            >
              {workspaceName}
            </h2>
          </div>
          <dl className="mt-1 space-y-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Customer availability")}</dt>
              <dd data-testid="character-customer-status">
                <strong>{t(servingLabel)}</strong>
                {releaseOrdinal ? ` · ${t("Release")} #${releaseOrdinal}` : ""}
                {discoveryLabel ? ` · ${t(discoveryLabel)}` : ""}
              </dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Draft")}</dt>
              <dd data-testid="character-draft-status">
                {draftStatus ? `${draftStatus} · ` : ""}{t("{completed}/{total} display images ready", { completed, total })}
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
      {hasQuickPublish && guardedPermissions.publishRelease ? (
        <WorkspaceButton
          disabled={writesLocked || quickActionBusy !== null}
          onClick={onOpenRelease}
          tone="primary"
        >
          {t("Preview and publish")}
        </WorkspaceButton>
      ) : null}
      {tab !== "release" && servingState === "live" && guardedPermissions.publishRelease ? (
        <WorkspaceButton
          disabled={writesLocked || quickActionBusy !== null}
          onClick={() => void quickToggleServing("pause")}
        >
          {t("Pause serving")}
        </WorkspaceButton>
      ) : tab !== "release" && servingState === "paused" && guardedPermissions.publishRelease ? (
        <WorkspaceButton
          disabled={writesLocked || quickActionBusy !== null}
          onClick={() => void quickToggleServing("resume")}
          tone="primary"
        >
          {t("Resume serving")}
        </WorkspaceButton>
      ) : null}
      {tab !== "release" && servingState === "live" &&
      ["public", "unlisted"].includes(data.character.visibility) &&
      guardedPermissions.manageCatalogVisibility ? (
        <WorkspaceButton
          disabled={writesLocked || quickActionBusy !== null}
          onClick={() => void quickToggleVisibility()}
        >
          {t(data.character.visibility === "unlisted" ? "Show in Explore" : "Hide from Explore")}
        </WorkspaceButton>
      ) : null}
      {tab !== "project" && servingState === "live" && permissions.readContent ? (
        <CharacterFeaturedToggle
          canWrite={guardedPermissions.manageFeatured}
          characterId={data.character.id}
          compact
        />
      ) : null}
      {canCreateCharacters && permissions.writeProject ? (
        <CharacterDuplicateButton characterId={id} />
      ) : null}
      <details className="text-xs text-[var(--ad-text-muted)] sm:text-right">
        <summary className="cursor-pointer py-2 font-semibold">
          {t("Technical status")}
        </summary>
        <p>
          {t("Draft v")}
          {data.project.version} {t("· Serving v")}
          {data.serving?.version ?? 0}
        </p>
        <p className="mt-1 break-all">
          {t("Character ID")} · {data.character.id}
        </p>
        <p className="mt-1 break-all">
          {t("Workspace ID")} · {data.project.id}
        </p>
        <p className="mt-1">{t("Updated")} {format.dateTime(data.character.updatedAt)}</p>
      </details>
      </div>
    </div>
  );
}
