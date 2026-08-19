"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiWrite } from "@/components/admin/api";
import { characterAssetReadinessAction } from "@/features/characters/character-asset-studio-authority";
import {
  VisualIdentityExperimentWorkbench,
  type ActivateIdentityCandidateInput,
} from "@/features/characters/VisualIdentityExperimentWorkbench";
import type { CharacterWorkspaceTab } from "@/features/image-workflow-transport";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

export type VisualIdentityPanelData = Pick<
  CharacterWorkspaceDetail,
  "visual"
> & {
  character: Pick<
    CharacterWorkspaceDetail["character"],
    "id" | "name" | "style" | "imageUrl"
  >;
};

export function uniqueAvailableVisualAssets<
  T extends { readonly available: boolean; readonly mediaAssetId: string },
>(assets: readonly T[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (!asset.available || seen.has(asset.mediaAssetId)) return false;
    seen.add(asset.mediaAssetId);
    return true;
  });
}

export function referenceIdsRemovedFromPublishedSet(
  activeReferenceIds: readonly string[],
  selectedReferenceIds: readonly string[],
) {
  const selected = new Set(selectedReferenceIds);
  return [...new Set(activeReferenceIds)].filter((id) => !selected.has(id));
}

export function requiresReviewedIdentityBootstrap(input: {
  readonly hasActiveIdentity: boolean;
  readonly hasCurrentCharacterImage: boolean;
  readonly availableReferenceCount: number;
  readonly hasActiveReferenceSet: boolean;
}) {
  return (
    !input.hasCurrentCharacterImage &&
    (!input.hasActiveIdentity ||
      (input.availableReferenceCount === 0 && !input.hasActiveReferenceSet))
  );
}

export function VisualIdentityPanel({
  data,
  navigateToTab,
  permissions,
  runCommittedMutation,
}: {
  data: VisualIdentityPanelData;
  permissions: Pick<
    CharacterWorkspacePermissions,
    "writeVisual" | "evaluateRoute"
  > &
    Partial<
      Pick<
        CharacterWorkspacePermissions,
        "writeProject" | "createAssets" | "reviewAssets"
      >
    >;
  runCommittedMutation: RunCommittedCharacterMutation;
  navigateToTab?: (tab: CharacterWorkspaceTab) => void;
}) {
  const { t } = useAdminI18n();
  const identity = data.visual.activeIdentity;
  const [identityPrompt, setIdentityPrompt] = useState(
    identity?.identityPrompt ?? "",
  );
  const [negativeIdentityPrompt, setNegativeIdentityPrompt] = useState(
    identity?.negativeIdentityPrompt ?? "",
  );
  const [style, setStyle] = useState(identity?.style ?? data.character.style);
  const [defaultSeed, setDefaultSeed] = useState(identity?.defaultSeed ?? "");
  const [identityReason, setIdentityReason] = useState("");
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const routeEvaluation = data.visual.routeEvaluation;
  const activeGenerationRoute =
    data.visual.routeQualifications.find(
      (route) => route.result === "qualified" && !route.stale,
    ) ?? null;
  const recommendedGenerationProfile =
    routeEvaluation.profiles.find((profile) => profile.recommended) ??
    routeEvaluation.profiles[0] ??
    null;
  const [productionSettingsOpen, setProductionSettingsOpen] = useState(
    !data.visual.readiness.ready,
  );
  // INTENT: 「身份是否受阻」由服务端 imageReadiness.steps 判定；前端曾用一张 code→锚点表反推，
  // 那张表漏了 visual_identity_missing 与 visual_anchor_missing，这两类阻塞时面板不会自动展开。
  const identityVersionNeedsAttention =
    (data.visual.imageReadiness?.steps.identity ?? "complete") !== "complete";
  const [advancedIdentityOpen, setAdvancedIdentityOpen] = useState(
    identityVersionNeedsAttention,
  );
  const referenceCandidates = useMemo(
    () =>
      uniqueAvailableVisualAssets([
        ...data.visual.anchors,
        ...data.visual.references,
      ]),
    [data.visual.anchors, data.visual.references],
  );
  // SPEC: 参考集只有一个网格 —— 看图即可勾选。
  // INTENT: 拆成"缩略图展示区 + 纯 media ID 勾选区"时，运营要靠 ID 在两区之间对照才能
  // 剔除掉混进锚点池的多人合照/他人脸，实际不可用。不可用资产保留展示但禁止勾选，
  // 以免"少了一张"却查不到原因。
  const referenceRows = useMemo(() => {
    const activeIds = new Set(
      (data.visual.activeReferenceSet?.references ?? []).map(
        (reference) => reference.mediaAssetId,
      ),
    );
    const seen = new Set<string>();
    return [
      ...data.visual.anchors,
      ...data.visual.references,
      ...(data.visual.activeReferenceSet?.references ?? []),
    ]
      .filter((asset) => {
        if (seen.has(asset.mediaAssetId)) return false;
        seen.add(asset.mediaAssetId);
        return true;
      })
      .map((asset) => ({
        asset,
        active: activeIds.has(asset.mediaAssetId),
        selectable: asset.available,
      }));
  }, [
    data.visual.activeReferenceSet,
    data.visual.anchors,
    data.visual.references,
  ]);
  const requiresReviewedBootstrap =
    requiresReviewedIdentityBootstrap({
      hasActiveIdentity: identity !== null,
      hasCurrentCharacterImage: Boolean(data.character.imageUrl),
      availableReferenceCount: referenceCandidates.length,
      hasActiveReferenceSet: data.visual.activeReferenceSet !== null,
    }) && data.visual.identityBootstrap.allowed;
  const usesCurrentCharacterImageAsAnchor =
    Boolean(data.character.imageUrl) &&
    referenceCandidates.length === 0 &&
    data.visual.activeReferenceSet === null;
  const blockedIdentityRepair =
    data.visual.identityBootstrap.state === "blocked_existing_authority" &&
    !usesCurrentCharacterImageAsAnchor &&
    referenceCandidates.length === 0;
  const activeReferenceIds = useMemo(
    () =>
      data.visual.activeReferenceSet?.references.map(
        (reference) => reference.mediaAssetId,
      ) ?? [],
    [data.visual.activeReferenceSet],
  );
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>(
    () =>
      data.visual.activeReferenceSet
        ? activeReferenceIds
        : referenceCandidates.map((asset) => asset.mediaAssetId),
  );
  const [referenceReason, setReferenceReason] = useState("");
  const [referenceConfirmed, setReferenceConfirmed] = useState(false);
  const [selectedLookId, setSelectedLookId] = useState<string | null>(null);
  const [lookArchiveReason, setLookArchiveReason] = useState("");
  const [busy, setBusy] = useState<"identity" | "references" | "look" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  const removedReferenceIds = referenceIdsRemovedFromPublishedSet(
    activeReferenceIds,
    selectedReferenceIds,
  );
  const readinessActions = useMemo(() => {
    const grouped = new Map<
      string,
      {
        readonly deepLink: string;
        readonly messages: string[];
        readonly codes: string[];
      }
    >();
    for (const blocker of data.visual.readiness.blockers) {
      const action = characterAssetReadinessAction(blocker.code);
      const existing = grouped.get(action);
      grouped.set(action, {
        deepLink: existing?.deepLink ?? blocker.deepLink,
        messages: [...(existing?.messages ?? []), blocker.message],
        codes: [...(existing?.codes ?? []), blocker.code],
      });
    }
    return [...grouped].map(([action, value]) => ({ action, ...value }));
  }, [data.visual.readiness.blockers]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedReferenceIds(
        data.visual.activeReferenceSet
          ? activeReferenceIds
          : referenceCandidates.map((asset) => asset.mediaAssetId),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeReferenceIds,
    data.visual.activeIdentity?.id,
    data.visual.activeReferenceSet,
    referenceCandidates,
  ]);
  const stableIdempotencyKey = (scope: string, payload: unknown) => {
    const signature = `${scope}:${JSON.stringify(payload)}`;
    const key = idempotencyKeys.current[signature] ?? crypto.randomUUID();
    idempotencyKeys.current[signature] = key;
    return { key, signature };
  };

  const createIdentityVersion = async () => {
    setBusy("identity");
    setError(null);
    const body = {
      identityPrompt: identityPrompt.trim() || undefined,
      negativeIdentityPrompt: negativeIdentityPrompt.trim() || undefined,
      style,
      defaultSeed: defaultSeed.trim() || undefined,
      reason: identityReason.trim(),
      confirmation: identityConfirmed
        ? `${data.character.id}:visual-profile`
        : "",
    };
    const requestIdentity = stableIdempotencyKey("visual-profile", body);
    try {
      await runCommittedMutation({
        action: "Visual Identity version",
        commit: () =>
          apiWrite(
            `/api/v2/admin/content/characters/${data.character.id}/visual-profiles`,
            "POST",
            body,
            {
              "idempotency-key": requestIdentity.key,
              "x-request-id": crypto.randomUUID(),
            },
          ),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setIdentityReason("");
          setIdentityConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Visual Identity version could not be created",
      );
    } finally {
      setBusy(null);
    }
  };

  const activateIdentityCandidate = async (
    body: ActivateIdentityCandidateInput,
  ) => {
    const requestIdentity = stableIdempotencyKey(
      "activate-identity-candidate",
      body,
    );
    await runCommittedMutation({
      action: "Identity candidate activation",
      commit: () =>
        apiWrite(
          `/api/v2/admin/content/characters/${data.character.id}/visual-profiles`,
          "POST",
          body,
          {
            "idempotency-key": requestIdentity.key,
            "x-request-id": crypto.randomUUID(),
          },
        ),
      afterRefresh: () => {
        delete idempotencyKeys.current[requestIdentity.signature];
      },
    });
  };

  const publishReferenceSet = async () => {
    if (!identity) return;
    setBusy("references");
    setError(null);
    const selected = referenceCandidates.filter((asset) =>
      selectedReferenceIds.includes(asset.mediaAssetId),
    );
    const body = {
      visualProfileId: identity.id,
      expectedActiveReferenceSetRevisionId:
        data.visual.activeReferenceSet?.id ?? null,
      expectedActiveReferenceSetRevision:
        data.visual.activeReferenceSet?.revision ?? 0,
      selectorVersion: "admin-visual-workbench-v1",
      references: selected.map((asset) => ({
        mediaAssetId: asset.mediaAssetId,
        role: asset.role,
        weight: 1,
      })),
      reason: {
        code: "reference_snapshot_publish",
        summary: referenceReason.trim(),
      },
      confirmation: referenceConfirmed
        ? `PUBLISH REFERENCES ${data.character.id}`
        : "",
    };
    const requestIdentity = stableIdempotencyKey("reference-set", body);
    try {
      await runCommittedMutation({
        action: "Reference Set publication",
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/reference-sets", {
            path: { id: data.character.id },
            idempotencyKey: requestIdentity.key,
            body,
          }),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setReferenceReason("");
          setReferenceConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Reference Set could not be published",
      );
    } finally {
      setBusy(null);
    }
  };

  const archiveLook = async () => {
    const look = (data.visual.looks ?? []).find(
      (item) => item.id === selectedLookId,
    );
    if (!look) return;
    setBusy("look");
    setError(null);
    const body = {
      operation: "archive" as const,
      expectedUpdatedAt: look.updatedAt,
      reason: {
        code: "look_retired",
        summary: lookArchiveReason.trim() || "Archived by operator",
      },
      confirmation: `ARCHIVE LOOK ${look.id}`,
    };
    const requestIdentity = stableIdempotencyKey(
      `archive-look:${look.id}`,
      body,
    );
    try {
      await runCommittedMutation({
        action: "Character Look archive",
        commit: () =>
          adminV2Operation("PATCH /api/v2/admin/characters/:id/looks/:lookId", {
            path: { id: data.character.id, lookId: look.id },
            idempotencyKey: requestIdentity.key,
            body,
          }),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setSelectedLookId(null);
          setLookArchiveReason("");
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Character Look could not be archived",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <VisualIdentityExperimentWorkbench
        canActivate={permissions.writeVisual}
        canCreate={permissions.createAssets ?? false}
        canUploadSource={
          (permissions.writeProject ?? false) &&
          (permissions.createAssets ?? false)
        }
        canReview={permissions.reviewAssets ?? false}
        data={data}
        onActivateCandidate={activateIdentityCandidate}
      />
      <details
        className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-black/[0.015]"
        id="visual-production-readiness"
        onToggle={(event) =>
          setProductionSettingsOpen(event.currentTarget.open)
        }
        open={productionSettingsOpen || !data.visual.readiness.ready}
      >
        <summary className="cursor-pointer px-4 py-4 text-sm font-semibold sm:px-5">
          {t("Official identity and production settings")}
        </summary>
        <div className="grid gap-5 border-t border-[var(--ad-border)] p-4 xl:grid-cols-[minmax(0,1fr)_380px] sm:p-5">
          <div className="space-y-5">
            <section
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              aria-labelledby="visual-authority-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="visual-authority-title">
                    {t("Visual Identity authority")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Selection, published references, and the active image route are separate evidence.",
                    )}
                  </p>
                </div>
                <StatusBadge
                  value={
                    data.visual.readiness.ready ? "visual ready" : "blocked"
                  }
                />
              </div>
              {identity ? (
                <>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Active identity")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        v{identity.version} · {identity.style}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Anchors available")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {
                          data.visual.anchors.filter((asset) => asset.available)
                            .length
                        }
                        /{data.visual.anchors.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Reference Set")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {data.visual.activeReferenceSet
                          ? t("revision {version}", {
                              version: data.visual.activeReferenceSet.revision,
                            })
                          : t("Not published")}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 rounded-lg bg-black/[0.03] p-3 text-sm">
                    {identity.identityPrompt}
                  </p>
                </>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {t("No active immutable Visual Identity version exists.")}
                </p>
              )}
              {readinessActions.length ? (
                <div className="mt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                    {t("Image-production readiness")}
                  </h4>
                  <ol
                    aria-label={t("Image production readiness")}
                    className="mt-2 space-y-2"
                  >
                    {readinessActions.map((item, index) => (
                      <li
                        aria-current={index === 0 ? "step" : undefined}
                        className="flex flex-col gap-2 rounded-lg border border-[var(--ad-border)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                        key={item.action}
                      >
                        <span className="flex gap-3">
                          <span
                            aria-hidden="true"
                            className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--ad-border)] text-xs font-semibold"
                          >
                            {index + 1}
                          </span>
                          <span>
                            <strong>{t(item.action)}</strong>
                            <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
                              {item.messages
                                .map((message) => t(message))
                                .join(" ")}
                            </span>
                          </span>
                        </span>
                        <Link
                          aria-label={t("Resolve: {action}", {
                            action: t(item.action),
                          })}
                          className="shrink-0 text-xs font-semibold underline"
                          href={item.deepLink}
                        >
                          {t("Resolve")}
                        </Link>
                      </li>
                    ))}
                  </ol>
                  <details className="mt-3 text-xs text-[var(--ad-text-muted)]">
                    <summary className="cursor-pointer font-semibold">
                      {t("Technical blocker codes")}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {readinessActions.flatMap((item) =>
                        item.codes.map((code) => <li key={code}>{code}</li>),
                      )}
                    </ul>
                  </details>
                </div>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-green-text)]">
                  {t("All visual evidence gates currently pass.")}
                </p>
              )}
            </section>

            <section
              className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="visual-reference-set"
              aria-labelledby="reference-set-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="reference-set-title">
                    {t("Anchors & published references")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Select available Identity assets, then seal an immutable Reference Set revision.",
                    )}
                  </p>
                </div>
                {navigateToTab ? (
                  <button
                    className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold"
                    onClick={() => navigateToTab("assets")}
                    type="button"
                  >
                    {t("Open role image production")}
                  </button>
                ) : (
                  <Link
                    className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold"
                    href={data.visual.readiness.productionDeepLink}
                  >
                    {t("Open role image production")}
                  </Link>
                )}
              </div>
              {identity ? (
                <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "Only checked images become active generation references. Unchecked images leave runtime authority after this revision is published; historical snapshots remain unchanged.",
                  )}
                </p>
              ) : null}
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {referenceRows.length === 0 ? (
                  <p className="text-sm text-[var(--ad-text-muted)]">
                    {t("No anchor or published reference assets.")}
                  </p>
                ) : (
                  referenceRows.map((row) => {
                    const checked = selectedReferenceIds.includes(
                      row.asset.mediaAssetId,
                    );
                    const preview = row.asset.thumbnailUrl ?? row.asset.url;
                    return (
                      <label
                        className={`block cursor-pointer rounded-lg border p-3 transition-colors ${
                          checked
                            ? "border-[var(--ad-ink)] bg-black/[0.03]"
                            : "border-[var(--ad-border)]"
                        } ${row.selectable ? "" : "cursor-not-allowed opacity-60"}`}
                        key={row.asset.mediaAssetId}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                            <input
                              checked={checked}
                              disabled={!row.selectable}
                              onChange={(event) =>
                                setSelectedReferenceIds((current) =>
                                  event.target.checked
                                    ? [
                                        ...new Set([
                                          ...current,
                                          row.asset.mediaAssetId,
                                        ]),
                                      ]
                                    : current.filter(
                                        (id) => id !== row.asset.mediaAssetId,
                                      ),
                                )
                              }
                              type="checkbox"
                            />
                            <span className="truncate">
                              {t(row.asset.role.replaceAll("_", " "))}
                            </span>
                          </span>
                          <StatusBadge
                            tone={row.active ? "good" : undefined}
                            value={
                              !row.asset.available
                                ? "unavailable"
                                : row.active
                                  ? "live reference"
                                  : "available"
                            }
                          />
                        </div>
                        {preview ? (
                          <Image
                            alt={t("Visual reference evidence")}
                            className="mt-3 aspect-square w-full rounded-md object-cover"
                            height={320}
                            src={preview}
                            unoptimized
                            width={320}
                          />
                        ) : null}
                        <p className="mt-2 truncate text-[11px] text-[var(--ad-text-muted)]">
                          {row.asset.mediaAssetId}
                        </p>
                      </label>
                    );
                  })
                )}
              </div>
              {identity ? (
                <div className="mt-5 border-t border-[var(--ad-border)] pt-4">
                  <h4 className="text-sm font-semibold">
                    {t("Publish Reference Set revision")}
                  </h4>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t("{count} of {total} images selected", {
                      count: selectedReferenceIds.length,
                      total: referenceCandidates.length,
                    })}
                  </p>
                  {removedReferenceIds.length > 0 ? (
                    <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                      {t(
                        "{count} current references will be removed from active generation.",
                        { count: removedReferenceIds.length },
                      )}
                    </p>
                  ) : null}
                  <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Publication reason")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) =>
                        setReferenceReason(event.target.value)
                      }
                      value={referenceReason}
                    />
                  </label>
                  <label className="mt-3 flex items-start gap-2 text-xs">
                    <input
                      checked={referenceConfirmed}
                      className="mt-0.5"
                      onChange={(event) =>
                        setReferenceConfirmed(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      {t(
                        "Publish a new immutable reference snapshot and supersede the active revision.",
                      )}
                    </span>
                  </label>
                  <div className="mt-4">
                    <WorkspaceButton
                      disabled={
                        !permissions.writeVisual ||
                        busy !== null ||
                        selectedReferenceIds.length === 0 ||
                        referenceReason.trim().length < 3 ||
                        !referenceConfirmed
                      }
                      onClick={() => void publishReferenceSet()}
                      tone="primary"
                    >
                      {t("Publish Reference Set")}
                    </WorkspaceButton>
                  </div>
                </div>
              ) : null}
            </section>

            <section
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="character-looks"
              aria-labelledby="character-looks-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="character-looks-title">
                    {t("Character Looks using role images")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Archive an unused Look before retiring its reference image. Historical generations keep their pinned snapshot.",
                    )}
                  </p>
                </div>
                <StatusBadge
                  value={`${(data.visual.looks ?? []).length} active`}
                />
              </div>
              {(data.visual.looks ?? []).length === 0 ? (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {t(
                    "No active or rebase-required Looks depend on this Character.",
                  )}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {(data.visual.looks ?? []).map((look) => (
                    <article
                      className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] p-3 sm:flex-row sm:items-center sm:justify-between"
                      key={look.id}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">{look.label}</strong>
                          <StatusBadge value={look.status} />
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--ad-text-muted)]">
                          {look.id} {t("· reference")}{" "}
                          {look.referenceAssetId ?? t("none")}
                        </p>
                      </div>
                      <WorkspaceButton
                        disabled={!permissions.writeVisual || busy !== null}
                        onClick={() => {
                          setSelectedLookId(look.id);
                          setLookArchiveReason("");
                        }}
                      >
                        {t("Archive Look")}
                      </WorkspaceButton>
                    </article>
                  ))}
                </div>
              )}
              {selectedLookId ? (
                <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
                  <h4 className="text-sm font-semibold">
                    {t("Archive")} {selectedLookId}
                  </h4>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "This removes the active Look dependency. It does not delete the role image.",
                    )}
                  </p>
                  <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Reason")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) =>
                        setLookArchiveReason(event.target.value)
                      }
                      value={lookArchiveReason}
                    />
                  </label>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <WorkspaceButton
                      // 归档 Look 是可逆的（status 可改回 active），按钮本身即确认动作——
                      // 不再要求先填理由、再默写内部 ID。
                      disabled={busy !== null}
                      onClick={() => void archiveLook()}
                      tone="primary"
                    >
                      {t("Confirm archive")}
                    </WorkspaceButton>
                    <WorkspaceButton
                      disabled={busy !== null}
                      onClick={() => {
                        setSelectedLookId(null);
                        setLookArchiveReason("");
                      }}
                    >
                      {t("Cancel")}
                    </WorkspaceButton>
                  </div>
                </div>
              ) : null}
            </section>

            <section
              aria-labelledby="single-image-policy-title"
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
            >
              <h3 className="font-semibold" id="single-image-policy-title">
                {t("One image at a time")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">
                {t(
                  "Every generation creates one candidate. Review that image before selecting it for the draft asset pack; nothing changes the live character automatically.",
                )}
              </p>
            </section>
          </div>

          <aside className="space-y-5">
            <details
              className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="visual-identity-version"
              onToggle={(event) =>
                setAdvancedIdentityOpen(event.currentTarget.open)
              }
              open={advancedIdentityOpen || identityVersionNeedsAttention}
            >
              <summary className="cursor-pointer font-semibold">
                {t("Advanced identity controls")}
              </summary>
              <section className="mt-4" aria-labelledby="new-identity-title">
                <h3 className="font-semibold" id="new-identity-title">
                  {t("Create identity version")}
                </h3>
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t(
                    "Creates a new active immutable version; existing assets are carried forward.",
                  )}
                </p>
                {requiresReviewedBootstrap ? (
                  <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
                    <p>
                      {t(
                        "Establish a reviewed portrait anchor in Character Assets before creating later identity versions.",
                      )}
                    </p>
                    {navigateToTab ? (
                      <div className="mt-3">
                        <WorkspaceButton
                          onClick={() => navigateToTab("assets")}
                        >
                          {t("Open Character Assets")}
                        </WorkspaceButton>
                      </div>
                    ) : null}
                  </div>
                ) : blockedIdentityRepair ? (
                  <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
                    <p>
                      {t(
                        "This character has earlier visual history but no usable portrait authority. Repair its reviewed image evidence before creating another identity version.",
                      )}
                    </p>
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer font-semibold">
                        {t("Technical identity diagnostics")}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {data.visual.identityBootstrap.blockers.map(
                          (blocker) => (
                            <li key={blocker}>{blocker}</li>
                          ),
                        )}
                      </ul>
                    </details>
                  </div>
                ) : usesCurrentCharacterImageAsAnchor ? (
                  <p className="mt-4 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm text-[var(--ad-blue-text)]">
                    {t(
                      "The current Character image is available and will be carried forward as the anchor for this identity version.",
                    )}
                  </p>
                ) : null}
                <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Identity lock")}
                  <textarea
                    className={`${textAreaClass} mt-1`}
                    onChange={(event) => setIdentityPrompt(event.target.value)}
                    value={identityPrompt}
                  />
                </label>
                <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Must not change")}
                  <textarea
                    className={`${textAreaClass} mt-1`}
                    onChange={(event) =>
                      setNegativeIdentityPrompt(event.target.value)
                    }
                    value={negativeIdentityPrompt}
                  />
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Style")}
                    <select
                      className={`${fieldClass} mt-1`}
                      onChange={(event) => setStyle(event.target.value)}
                      value={style}
                    >
                      {["realistic", "anime", "hybrid", "other"].map(
                        (value) => (
                          <option key={value}>{value}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Seed")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) => setDefaultSeed(event.target.value)}
                      value={defaultSeed}
                    />
                  </label>
                </div>
                <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Change reason")}
                  <input
                    className={`${fieldClass} mt-1`}
                    onChange={(event) => setIdentityReason(event.target.value)}
                    value={identityReason}
                  />
                </label>
                <label className="mt-3 flex items-start gap-2 text-xs">
                  <input
                    checked={identityConfirmed}
                    className="mt-0.5"
                    onChange={(event) =>
                      setIdentityConfirmed(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>{t("Activate this as a new identity version.")}</span>
                </label>
                <div className="mt-4">
                  <WorkspaceButton
                    disabled={
                      requiresReviewedBootstrap ||
                      blockedIdentityRepair ||
                      !permissions.writeVisual ||
                      busy !== null ||
                      identityReason.trim().length < 3 ||
                      !identityConfirmed
                    }
                    onClick={() => void createIdentityVersion()}
                    tone="primary"
                  >
                    {t("Create & activate version")}
                  </WorkspaceButton>
                </div>
                {!permissions.writeVisual ? (
                  <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                    {t("Read-only: content.official.write is not granted.")}
                  </p>
                ) : null}
              </section>
            </details>
            <details
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="route-qualification-workbench"
              open
            >
              <summary className="cursor-pointer font-semibold">
                {t("Image generation route")}
              </summary>
              <section
                className="mt-4"
                aria-labelledby="generation-route-title"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3
                      className="text-lg font-semibold"
                      id="generation-route-title"
                    >
                      {activeGenerationRoute?.generationProfileKey ??
                        recommendedGenerationProfile?.label ??
                        t("No compatible image route")}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                      {activeGenerationRoute
                        ? `${activeGenerationRoute.workflowKey} · v${activeGenerationRoute.workflowVersion}`
                        : recommendedGenerationProfile
                          ? `${recommendedGenerationProfile.workflowKey} · v${recommendedGenerationProfile.workflowVersion}`
                          : t(
                              routeEvaluation.blocker ??
                                "No active reference-capable image profile can consume this Reference Set.",
                            )}
                    </p>
                  </div>
                  <StatusBadge
                    value={
                      activeGenerationRoute || recommendedGenerationProfile
                        ? "ready"
                        : "blocked"
                    }
                  />
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "The platform keeps the compatible route fixed for lineage. Operators create and review one image at a time; no test images are required first.",
                  )}
                </p>
                {navigateToTab &&
                (activeGenerationRoute || recommendedGenerationProfile) ? (
                  <WorkspaceButton
                    className="mt-4"
                    onClick={() => navigateToTab("assets")}
                    tone="primary"
                  >
                    {t("Generate one image")}
                  </WorkspaceButton>
                ) : null}
              </section>
            </details>
            {error ? (
              <p className="text-sm text-[var(--ad-red-text)]" role="alert">
                {error}
              </p>
            ) : null}
          </aside>
        </div>
      </details>
    </div>
  );
}
