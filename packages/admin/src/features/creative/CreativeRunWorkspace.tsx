"use client";

import Link from "next/link";
import {
  adminCommandAcceptedSchema,
  adminCommandStatusSchema,
  creativeRunCreateRequestSchema,
  creativeRunCreateResultSchema,
  creativeRunCreateOptionsSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CreativeRunCreateOptions,
  type CreativeRun,
  type CreativeRunDetail,
  type AdminCommandStatus,
} from "@idream/shared/admin";
import { ArrowLeft, Check, ImageIcon, Plus, RefreshCcw, RotateCcw, Send, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { creativeRetryFailedMutation } from "@/features/image-workflow-transport";
import { EmptyWorkspace, LoadingWorkspace, StatusBadge, WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import {
  AdminV2RequestError,
  adminV2Request,
} from "@/lib/admin-v2-api";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";
import { cn } from "@/lib/utils";

type Permissions = { read: boolean; write: boolean; review: boolean; place: boolean; manageIncident?: boolean };

export function nonCampaignReviewSummary(input: {
  readonly lifecycleState: string;
  readonly itemReviewed: boolean;
}) {
  if (input.lifecycleState === "closed") {
    return {
      title: "Review complete",
      description: "This intended use does not yet have a verified runtime destination. Review is complete; hand the reviewed asset to its downstream owner without marking it live here.",
      complete: true,
    } as const;
  }
  if (input.itemReviewed) {
    return {
      title: "Candidate reviewed",
      description: "This candidate has a decision, but the Run is still open. Review every remaining candidate before downstream handoff.",
      complete: false,
    } as const;
  }
  return {
    title: "Review required",
    description: "This Run is still awaiting a review decision. Nothing is ready for downstream handoff yet.",
    complete: false,
  } as const;
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

export function canTerminallyRejectUnusedApproval(input: {
  readonly purpose: string;
  readonly lifecycleState: string;
  readonly decision: string | null;
  readonly hasPlacement: boolean;
}) {
  const characterAssetPurpose = [
    "character_cover",
    "character_hero",
    "character_chat",
  ].includes(input.purpose);
  const lifecycleEligible =
    input.purpose === "campaign"
      ? input.lifecycleState === "active"
      : characterAssetPurpose
        ? ["active", "closed"].includes(input.lifecycleState)
        : false;
  return lifecycleEligible &&
    input.decision === "approved" &&
    !input.hasPlacement;
}

const reviewQualityChecks = [
  ["artifactFree", "No visible artifacts"],
  ["singleSubject", "Exactly one intended subject"],
  ["intentMatch", "Composition matches the intended use"],
  ["noVisibleText", "No visible text, watermark, or contact sheet"],
] as const;

function denied() {
  return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h2 className="mt-4 text-lg font-semibold"><AdminText text="No permission" /></h2><p className="mt-2 text-sm text-[var(--ad-text-muted)]"><AdminText text="creative.run.read is required for this workspace." /></p></section>;
}

function isGenericCreativePurpose(
  value: string,
): value is CreativeRunCreateOptions["purposes"][number]["value"] {
  return [
    "feed",
    "homepage",
    "seo",
    "template_cover",
    "campaign",
  ].includes(value);
}

function CreateRunForm({
  actorId,
  enabled,
}: {
  actorId: string;
  enabled: boolean;
}) {
  const { t } = useAdminI18n();
  const createScope = `creative-run:create:${actorId}`;
  const [createIntent, setCreateIntent] =
    useState<DurableMutationIntent | null>(() =>
      readActiveDurableMutationIntent({ scope: createScope })
    );
  const [recoveredCreateRequest] = useState(() => {
    const parsed = creativeRunCreateRequestSchema.safeParse(
      createIntent?.requestSnapshot,
    );
    return parsed.success ? parsed.data : null;
  });
  const [title, setTitle] = useState(
    recoveredCreateRequest?.title ?? "",
  );
  const [purpose, setPurpose] = useState<CreativeRunCreateOptions["purposes"][number]["value"]>(
    recoveredCreateRequest &&
      isGenericCreativePurpose(recoveredCreateRequest.purpose)
      ? recoveredCreateRequest.purpose
      : "campaign",
  );
  const [profileId, setProfileId] = useState(
    recoveredCreateRequest?.profileId ?? "",
  );
  const [orientation, setOrientation] = useState(
    recoveredCreateRequest?.orientation ?? "",
  );
  const [count, setCount] = useState(
    String(recoveredCreateRequest?.count ?? 4),
  );
  const [brief, setBrief] = useState(
    recoveredCreateRequest?.brief ?? "",
  );
  const [options, setOptions] = useState<CreativeRunCreateOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const loadOptions = async () => {
      setLoadingOptions(true);
      setError(null);
      try {
        const next = await adminV2Request("/api/v2/admin/creative/run-options", {
          schema: creativeRunCreateOptionsSchema,
        });
        if (!active) return;
        setOptions(next);
        const recommended = next.profiles.find((profile) => profile.recommended) ?? next.profiles[0];
        if (recommended && !recoveredCreateRequest) {
          setProfileId(recommended.profileKey);
          const purposeOption = next.purposes.find((option) => option.value === "campaign");
          setOrientation(
            purposeOption && recommended.allowedOrientations.includes(purposeOption.defaultOrientation)
              ? purposeOption.defaultOrientation
              : recommended.allowedOrientations[0] ?? "",
          );
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : t("Creation options could not be loaded."));
        }
      } finally {
        if (active) setLoadingOptions(false);
      }
    };
    void loadOptions();
    return () => {
      active = false;
    };
  }, [enabled, recoveredCreateRequest, t]);
  if (!enabled) return null;
  const selectedProfile = options?.profiles.find((profile) => profile.profileKey === profileId) ?? null;
  const selectedPurpose = options?.purposes.find((option) => option.value === purpose) ?? null;
  const choosePurpose = (next: CreativeRunCreateOptions["purposes"][number]["value"]) => {
    setPurpose(next);
    const purposeOption = options?.purposes.find((option) => option.value === next);
    if (purposeOption && selectedProfile) {
      setOrientation(
        selectedProfile.allowedOrientations.includes(purposeOption.defaultOrientation)
          ? purposeOption.defaultOrientation
          : selectedProfile.allowedOrientations[0] ?? "",
      );
    }
  };
  const chooseProfile = (next: string) => {
    setProfileId(next);
    const profile = options?.profiles.find((option) => option.profileKey === next);
    if (profile) {
      setOrientation(
        selectedPurpose && profile.allowedOrientations.includes(selectedPurpose.defaultOrientation)
          ? selectedPurpose.defaultOrientation
          : profile.allowedOrientations[0] ?? "",
      );
    }
  };
  const restoreCreateRequest = (
    request: ReturnType<
      typeof creativeRunCreateRequestSchema.parse
    >,
  ) => {
    setTitle(request.title ?? "");
    if (isGenericCreativePurpose(request.purpose)) {
      setPurpose(request.purpose);
    }
    setProfileId(request.profileId);
    setOrientation(request.orientation ?? "");
    setCount(String(request.count));
    setBrief(request.brief);
  };
  const create = async () => {
    if (
      createIntent?.status === "committed_projection_pending" &&
      createIntent.committedTargetId
    ) {
      setBusy(true);
      setError(null);
      try {
        await adminV2Request(
          `/api/v2/admin/creative/runs/${createIntent.committedTargetId}`,
          { schema: creativeRunDetailSchema },
        );
        clearDurableMutationIntent(createIntent);
        setCreateIntent(null);
        window.location.assign(
          `/admin/creative/runs/${createIntent.committedTargetId}`,
        );
      } catch (cause) {
        setError(
          `The committed Run projection is still unavailable${
            cause instanceof Error ? `: ${cause.message}` : ""
          }. Verification can be retried without another create request.`,
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    const savedRequest = createIntent
      ? creativeRunCreateRequestSchema.safeParse(
          createIntent.requestSnapshot,
        )
      : null;
    if (
      createIntent &&
      (
        createIntent.status === "reconciliation_required" ||
        (savedRequest !== null && !savedRequest.success)
      )
    ) {
      setBusy(true);
      setError(null);
      setRecoveryNotice(null);
      try {
        const receipt = await reconcileDurableMutationIntent({
          intent: createIntent,
          commandType: "creative.run.create",
        });
        if (receipt.state === "committed") {
          if (
            !receipt.committedTargetId ||
            receipt.verification?.kind !== "creative_run" ||
            receipt.verification.runId !==
              receipt.committedTargetId
          ) {
            throw new Error(
              "The committed Run receipt is missing exact projection evidence. The workspace remains locked.",
            );
          }
          const committed = updateDurableMutationIntent(createIntent, {
            status: "committed_projection_pending",
            committedTargetId: receipt.committedTargetId,
          });
          setCreateIntent(committed);
          await adminV2Request(
            `/api/v2/admin/creative/runs/${receipt.committedTargetId}`,
            { schema: creativeRunDetailSchema },
          );
          clearDurableMutationIntent(committed);
          setCreateIntent(null);
          window.location.assign(
            `/admin/creative/runs/${receipt.committedTargetId}`,
          );
          return;
        }
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(createIntent);
          setCreateIntent(null);
          setRecoveryNotice(
            "The old request had no committed effect. Its key was sealed on the server, so a new image request is now safe.",
          );
          return;
        }
        setError(receipt.state === "failed"
          ? `The saved command ${receipt.commandId} is terminally failed. Its key remains locked for operator investigation; do not submit a replacement Run.`
          : `The saved request is ${receipt.state}. Keep this workspace locked and reconcile again after the server reaches a terminal receipt.`);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved request could not be reconciled.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    const currentBody = {
      ...(title.trim() ? { title: title.trim() } : {}),
      purpose,
      targetType: "none" as const,
      profileId: profileId.trim(),
      presetIds: [],
      orientation,
      count: Number(count),
      brief: brief.trim(),
      consistencyMode: "balanced" as const,
      priority: "normal" as const,
      reason: "Launch an operator-authored Creative Run from its explicit brief",
    };
    const recovered = savedRequest;
    if (recovered && !recovered.success) {
      setError(
        "The saved creation intent is invalid and cannot be replayed. Clear expired browser data or contact an administrator.",
      );
      return;
    }
    let body;
    if (recovered?.success) {
      body = recovered.data;
    } else {
      const parsedCurrent =
        creativeRunCreateRequestSchema.safeParse(currentBody);
      if (!parsedCurrent.success) {
        setError(
          "The creation request is incomplete or no longer matches the active contract.",
        );
        return;
      }
      body = parsedCurrent.data;
    }
    const requestSignature = JSON.stringify(body);
    let intent = createIntent;
    if (!intent) {
      const claim = await claimDurableMutationIntent({
        scope: createScope,
        signature: requestSignature,
        requestSnapshot: body,
      });
      intent = claim.intent;
      if (
        intent.signature !== requestSignature ||
        [
          "committed_projection_pending",
          "reconciliation_required",
        ].includes(intent.status)
      ) {
        const saved = creativeRunCreateRequestSchema.safeParse(
          intent.requestSnapshot,
        );
        if (saved.success) restoreCreateRequest(saved.data);
        setCreateIntent(intent);
        setError(
          intent.status === "committed_projection_pending"
            ? "Another tab already has a committed Run receipt. Verify that receipt before creating again."
            : intent.status === "reconciliation_required"
              ? "Another tab has an aged request receipt. Reconcile it with the server before creating again."
            : "Another tab already started a different image creation request. Its exact request has been restored for safe resume.",
        );
        return;
      }
    }
    setCreateIntent(intent);
    setBusy(true); setError(null); setRecoveryNotice(null);
    let result: {
      readonly batch: { readonly id: string };
      readonly replayed: boolean;
    };
    try {
      result = await adminV2Request(
        "/api/v2/admin/creative/runs",
        {
          method: "POST",
          idempotencyKey: intent.idempotencyKey,
          schema: creativeRunCreateResultSchema,
          body,
        },
      );
    } catch (cause) {
      if (isDefinitiveAdminMutationRejection(cause)) {
        clearDurableMutationIntent(intent);
        setCreateIntent(null);
        setError(cause.message);
      } else {
        const unknown = updateDurableMutationIntent(intent, {
          status: "outcome_unknown",
        });
        setCreateIntent(unknown);
        setError(
          "Creation outcome is unknown. Choose Resume creation to replay the same intent without creating a duplicate Run.",
        );
      }
      setBusy(false);
      return;
    }
    const committed = updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: result.batch.id,
    });
    setCreateIntent(committed);
    try {
      await adminV2Request(
        `/api/v2/admin/creative/runs/${result.batch.id}`,
        { schema: creativeRunDetailSchema },
      );
      clearDurableMutationIntent(committed);
      setCreateIntent(null);
      window.location.assign(`/admin/creative/runs/${result.batch.id}`);
    } catch (cause) {
      setError(
        `The Run was created, but its projection could not be opened${
          cause instanceof Error ? `: ${cause.message}` : ""
        }. Choose Verify created Run to retry safely.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const ready = !loadingOptions &&
    options?.readiness.ready === true &&
    Boolean(selectedProfile) &&
    Boolean(orientation) &&
    brief.trim().length > 0 &&
    Number.isInteger(Number(count)) &&
    Number(count) >= 1 &&
    Number(count) <= 24;
  const readiness = loadingOptions
    ? t("Checking available image routes…")
    : options?.readiness.blocker
      ? t(options.readiness.blocker)
      : !selectedProfile
        ? t("No compatible text-to-image route is currently available.")
      : !brief.trim()
        ? t("Add a concrete brief to make the Run ready.")
        : t("Ready to create. Destination is chosen only after review.");
  return (
    <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5" aria-labelledby="create-creative-run-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Image creation")}</p>
          <h2 className="mt-1 text-lg font-semibold" id="create-creative-run-title">{t("Create images")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">{t("Start from the intended use and a concrete brief. Creation does not publish anything.")}</p>
        </div>
        <div className="rounded-lg bg-[var(--ad-blue-bg)] px-3 py-2 text-sm text-[var(--ad-blue-text)]">
          <span>{t("Creating Character images?")}</span>{" "}
          <Link className="font-semibold underline" href={options?.characterAssetStudioHref ?? "/admin/characters"}>
            {t("Open Character Asset Studio")}
          </Link>
        </div>
      </div>
      <fieldset className="mt-5">
        <legend className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("What are you making?")}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {(options?.purposes ?? []).map((option) => (
            <button
              aria-pressed={purpose === option.value}
              className={cn(
                "min-h-24 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2",
                purpose === option.value
                  ? "border-[var(--ad-ink)] bg-black/[0.04]"
                  : "border-[var(--ad-border)] hover:border-[var(--ad-text-muted)]",
              )}
              key={option.value}
              disabled={Boolean(createIntent)}
              onClick={() => choosePurpose(option.value)}
              type="button"
            >
              <strong className="text-sm">{t(option.label)}</strong>
              <span className="mt-1 block text-xs leading-5 text-[var(--ad-text-muted)]">{t(option.description)}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_140px]">
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Creative brief")}
          <textarea
            className={`${textAreaClass} mt-1 min-h-28`}
            disabled={Boolean(createIntent)}
            onChange={(event) => setBrief(event.target.value)}
            placeholder={t("Describe the subject, setting, composition, mood, and what success looks like.")}
            value={brief}
          />
        </label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Items")}
          <input className={`${fieldClass} mt-1`} disabled={Boolean(createIntent)} max={24} min={1} onChange={(event) => setCount(event.target.value)} type="number" value={count} />
        </label>
      </div>
      <details className="mt-3 rounded-lg border border-[var(--ad-border)] px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">{t("Advanced creation details")}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Run title")}
            <input className={`${fieldClass} mt-1`} disabled={Boolean(createIntent)} onChange={(event) => setTitle(event.target.value)} value={title} />
          </label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Image route")}
            <select className={`${fieldClass} mt-1`} disabled={Boolean(createIntent)} onChange={(event) => chooseProfile(event.target.value)} value={profileId}>
              {(options?.profiles ?? []).map((profile) => (
                <option key={`${profile.profileKey}:${profile.profileVersion}`} value={profile.profileKey}>
                  {t(profile.label)}{profile.recommended ? ` · ${t("Recommended")}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Canvas")}
            <select className={`${fieldClass} mt-1`} disabled={Boolean(createIntent)} onChange={(event) => setOrientation(event.target.value)} value={orientation}>
              {(selectedProfile?.allowedOrientations ?? []).map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </details>
      {error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      {recoveryNotice ? <p className="mt-3 rounded-md bg-[var(--ad-green-bg)] px-3 py-2 text-sm text-[var(--ad-green-text)]" role="status">{recoveryNotice}</p> : null}
      {createIntent?.committedTargetId ? <p className="mt-3 text-sm" role="status">{t("Created Run receipt:")} <Link className="font-medium underline underline-offset-4" href={`/admin/creative/runs/${createIntent.committedTargetId}`}>{t("open")} {createIntent.committedTargetId}</Link></p> : null}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className={cn("text-xs", ready ? "text-[var(--ad-green-text)]" : "text-[var(--ad-text-muted)]")} role="status">{readiness}</p>
        <WorkspaceButton disabled={busy || (!createIntent && !ready)} onClick={() => void create()} tone="primary">
          <Plus className="h-4 w-4" /> {t(
            createIntent?.status === "reconciliation_required" ||
                  (
                    createIntent !== null &&
                    !creativeRunCreateRequestSchema.safeParse(
                      createIntent.requestSnapshot,
                    ).success
                  )
              ? "Reconcile saved request"
              : createIntent?.status === "outcome_unknown" ||
                  createIntent?.status === "submitting"
                ? "Resume creation"
              : createIntent?.status === "committed_projection_pending"
                ? "Verify created Run"
                : "Create and launch",
          )}
        </WorkspaceButton>
      </div>
    </section>
  );
}

function RunList({
  actorId,
  permissions,
}: {
  actorId: string;
  permissions: Permissions;
}) {
  const { locale, t } = useAdminI18n();
  const [items, setItems] = useState<CreativeRun[]>([]);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState<{ endCursor: string | null; hasNextPage: boolean }>({ endCursor: null, hasNextPage: false });
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const successfulQueryKey = useRef<string | null>(null);

  const load = useCallback(async (next: { search: string; outcome: string; cursor?: string }, historyMode: "none" | "push" | "replace") => {
    if (!permissions.read) return;
    const request = requestGate.current.begin();
    const queryKey = JSON.stringify(next);
    if (successfulQueryKey.current !== queryKey) {
      setItems([]);
      setPageInfo({ endCursor: null, hasNextPage: false });
      setAsOf(null);
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (next.search.trim()) query.set("search", next.search.trim());
      if (next.outcome !== "all") query.set("executionOutcome", next.outcome);
      if (next.cursor) query.set("cursor", next.cursor);
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", `${window.location.pathname}?${query}`);
      }
      const data = await adminV2Request(`/api/v2/admin/creative/runs?${query}`, { schema: creativeRunListResponseSchema });
      if (!request.isCurrent()) return;
      setItems([...data.items]);
      setPageInfo(data.pageInfo);
      setAsOf(data.asOf);
      successfulQueryKey.current = queryKey;
    } catch (cause) {
      if (request.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Creative Runs could not be loaded");
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [permissions.read]);

  useEffect(() => {
    const gate = requestGate.current;
    const restore = (historyMode: "none" | "replace") => {
      const params = new URLSearchParams(window.location.search);
      const next = {
        search: params.get("search") ?? "",
        outcome: params.get("executionOutcome") ?? "all",
        cursor: params.get("cursor") ?? undefined,
      };
      setSearch(next.search);
      setOutcome(next.outcome);
      setCursor(next.cursor);
      void load(next, historyMode);
    };
    const timer = window.setTimeout(() => restore("replace"), 0);
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [load]);

  function apply(nextCursor?: string) {
    setCursor(nextCursor);
    void load({ search, outcome, cursor: nextCursor }, "push");
  }

  if (!permissions.read) return denied();
  const filtered = Boolean(search || outcome !== "all");
  return (
    <section aria-labelledby="creative-runs-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Creative Studio")}</p><h2 className="mt-1 text-2xl font-semibold" id="creative-runs-title">{t("Creative Runs")}</h2><p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">{t("Execution, review, placement, and verification remain separate facts.")}</p></div>
        <form className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_180px_auto]" onSubmit={(event) => { event.preventDefault(); apply(); }}>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search")}<input className={`${fieldClass} mt-1`} onChange={(event) => setSearch(event.target.value)} placeholder={t("Run, title or purpose")} value={search} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Outcome")}<select className={`${fieldClass} mt-1`} onChange={(event) => setOutcome(event.target.value)} value={outcome}>{["all", "pending", "running", "succeeded", "partially_succeeded", "failed", "cancelled"].map((value) => <option key={value}>{t(value.replaceAll("_", " "))}</option>)}</select></label>
          <WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>
        </form>
      </div>
      <CreateRunForm actorId={actorId} enabled={permissions.write} />
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load({ search, outcome, cursor }, "none")} type="button">{t("Retry")}</button></div> : null}
      <div className="mt-6">{loading && items.length === 0 ? <LoadingWorkspace label="Loading Creative Run facts" /> : items.length === 0 ? error ? null : <EmptyWorkspace filtered={filtered} onClear={() => { setSearch(""); setOutcome("all"); setCursor(undefined); void load({ search: "", outcome: "all" }, "push"); }} /> : <div className="grid gap-3">{items.map((run) => <Link className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 sm:grid-cols-[1fr_auto]" href={`/admin/creative/runs/${run.id}`} key={run.id}><div><div className="flex flex-wrap items-center gap-2"><strong>{t(run.purpose)}</strong><StatusBadge value={run.executionOutcome} /><StatusBadge value={run.reviewState} /><StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{run.target.type === "none" ? t("Destination chosen after review") : `${run.target.type}:${run.target.id}`} · {t(run.workflowStage)}  {t("· owner")} {run.ownerId ?? t("unassigned")}</p><div className="mt-3 flex flex-wrap gap-3 text-xs tabular-nums"><span>{run.counts.generated}/{run.counts.total}  {t("generated")}</span><span>{run.counts.failed}  {t("failed")}</span><span>{run.counts.approved}  {t("approved")}</span><span>{run.counts.placed}  {t("placed")}</span></div></div><span className="self-center text-xs text-[var(--ad-text-muted)]">{t("Open operator flow →")}</span></Link>)}</div>}</div>
      <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--ad-text-muted)]">{asOf ? t("Fresh as of {time}", { time: new Date(asOf).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") }) : t("No successful query yet")}</p><WorkspaceButton disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => apply(pageInfo.endCursor ?? undefined)}>{t("Next page")}</WorkspaceButton></div>
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
  ) : <div className="grid min-h-80 place-items-center text-[var(--ad-text-muted)]"><ImageIcon className="h-8 w-8" /><span>{t("No valid artifact")}</span></div>}</div><aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex flex-wrap gap-2"><StatusBadge value={item.executionState} /><StatusBadge value={item.status} /><StatusBadge value={item.retryability} /></div><dl className="mt-4 space-y-3 text-xs"><div><dt className="text-[var(--ad-text-muted)]">{t("Request / attempt")}</dt><dd className="mt-1 break-all">{item.lineage.requestId ?? t("Unavailable")}<br />{item.lineage.attemptId ?? t("Unavailable")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Provider request / Comfy prompt")}</dt><dd className="mt-1 break-all">{item.lineage.providerRequestId ?? t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Asset")}</dt><dd className="mt-1 break-all">{item.asset?.id ?? t("Unavailable")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Latest review")}</dt><dd className="mt-1">{item.review ? t("{decision} · {identity}", { decision: t(item.review.decision), identity: t(item.review.identityConsistency) }) : t("Pending")}</dd></div><div><dt className="text-[var(--ad-text-muted)]">{t("Placement")}</dt><dd className="mt-1">{item.placement ? t("{slot} · {verification}", { slot: t(item.placement.slot), verification: t(item.placement.verificationState) }) : t("Unplaced")}</dd></div></dl></aside></div>;
}

function ReviewContext({ run, itemIndex }: { run: CreativeRunDetail; itemIndex: number }) {
  const { t } = useAdminI18n();
  const item = run.items[itemIndex];
  return (
    <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="creative-review-context-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Decision context")}</p>
          <h3 className="mt-1 font-semibold" id="creative-review-context-title">{t("Review against the brief")}</h3>
        </div>
        <p className="text-xs text-[var(--ad-text-muted)]">{t("The brief and generation route are frozen evidence for this Run.")}</p>
      </div>
      <blockquote className="mt-4 border-l-2 border-[var(--ad-ink)] pl-4 text-sm leading-6">{run.reviewContext.brief}</blockquote>
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

function ReviewForm({
  run,
  itemIndex,
  permissions,
  reload,
  onAdvance,
}: {
  run: CreativeRunDetail;
  itemIndex: number;
  permissions: Permissions;
  reload: () => Promise<void>;
  onAdvance?: (index: number) => void;
}) {
  const { t } = useAdminI18n();
  const item = run.items[itemIndex];
  const identityReviewMode = item?.identityReviewMode ?? "not_applicable";
  const routeEvaluationReview = run.purpose === "model_eval";
  const [reason, setReason] = useState("");
  const [score, setScore] = useState("");
  const [identityConsistency, setIdentityConsistency] = useState<"passed" | "failed" | "unscored">(
    identityReviewMode === "preserves_identity" || routeEvaluationReview
      ? "passed"
      : "unscored",
  );
  const [quality, setQuality] = useState({
    artifactFree: false,
    singleSubject: false,
    intentMatch: false,
    noVisibleText: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  if (!item) return null;
  const characterAssetReview = run.purpose === "character_cover" ||
    run.purpose === "character_hero" ||
    run.purpose === "character_chat";
  const requiresEvidenceRepair = Boolean(
    item.review &&
    characterAssetReview &&
    item.review.quality === null,
  );
  const immutableReview = item.review && !requiresEvidenceRepair ? item.review : null;
  const canWithdrawApproval = canTerminallyRejectUnusedApproval({
    purpose: run.purpose,
    lifecycleState: run.lifecycleState,
    decision: immutableReview?.decision ?? null,
    hasPlacement: Boolean(item.placement),
  });
  const decide = async (decision: "approved" | "rejected") => {
    const numericScore = score.trim() ? Number(score) : undefined;
    const terminalApprovalRejection =
      decision === "rejected" && immutableReview?.decision === "approved";
    const submittedIdentityConsistency = terminalApprovalRejection
      ? immutableReview.identityConsistency
      : identityConsistency;
    const submittedScore = terminalApprovalRejection
      ? immutableReview.score ?? undefined
      : numericScore;
    const submittedQuality = terminalApprovalRejection
      ? immutableReview.quality ?? undefined
      : characterAssetReview
        ? quality
        : undefined;
    const validScore = numericScore !== undefined &&
      Number.isInteger(numericScore) &&
      numericScore >= 0 &&
      numericScore <= 100;
    if (
      reason.trim().length < 3 ||
      (decision === "approved" && !validScore) ||
      (routeEvaluationReview && (
        !validScore ||
        identityConsistency === "unscored"
      )) ||
      (characterAssetReview && decision === "approved" && Object.values(quality).some((passed) => !passed)) ||
      (decision === "approved" && identityReviewMode === "defines_identity" && identityConsistency !== "unscored") ||
      (decision === "approved" && identityReviewMode === "preserves_identity" && identityConsistency !== "passed")
    ) {
      setError(decision === "approved"
        ? "Approval requires an integer score from 0 to 100, complete visible checks, and concrete evidence."
        : "Rejection requires a concrete reason.");
      return;
    }
    const body = {
      entityVersion: run.version,
      ...(item.review ? { supersedesDecisionId: item.review.id } : {}),
      decision,
      identityConsistency: submittedIdentityConsistency,
      ...(submittedScore !== undefined ? { score: submittedScore } : {}),
      ...(submittedQuality ? { quality: submittedQuality } : {}),
      reason: reason.trim(),
    };
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
      if (routeEvaluationReview) {
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
  const validScore = score.trim().length > 0 &&
    Number.isInteger(Number(score)) &&
    Number(score) >= 0 &&
    Number(score) <= 100;
  const validReason = reason.trim().length >= 3;
  const allQualityPassed = Object.values(quality).every(Boolean);
  if (immutableReview) {
    return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="creative-review-title"><h3 className="font-semibold" id="creative-review-title">{t("Immutable review decision")}</h3><p className="mt-2 text-sm"><strong className="capitalize">{t(immutableReview.decision)}</strong> · {t("identity")} {t(immutableReview.identityConsistency)}{immutableReview.score !== null ? ` · ${immutableReview.score}/100` : ""}</p>{immutableReview.quality ? <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">{reviewQualityChecks.map(([key, label]) => <li className="rounded-md bg-black/[0.035] px-3 py-2" key={key}>{t(immutableReview.quality?.[key] ? "Passed" : "Failed")} · {t(label)}</li>)}</ul> : null}<p className="mt-3 text-sm leading-6 text-[var(--ad-text-muted)]">{immutableReview.reason}</p>{immutableReview.supersedesDecisionId ? <p className="mt-2 break-all text-xs text-[var(--ad-text-muted)]">{t("Supersedes")} {immutableReview.supersedesDecisionId}</p> : null}{canWithdrawApproval ? <div className="mt-4 border-t border-[var(--ad-border)] pt-4"><h4 className="text-sm font-semibold">{t("Terminal disposition")}</h4><p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t("If this approved candidate will not be activated, record a superseding rejection so every candidate has an explicit terminal outcome and the Run can close.")}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("The original score, identity result and visible-quality evidence are preserved. If the asset is selected by a Character authority, replace or withdraw it there first.")}</p><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Withdrawal reason")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} placeholder={t("Explain why this approved candidate will not be used")} value={reason} /></label>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}{warning ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}<div className="mt-3"><WorkspaceButton disabled={!permissions.review || busy || !validReason} onClick={() => void decide("rejected")} tone="danger"><X className="h-4 w-4" /> {characterAssetReview ? t("Record superseding rejection") : t("Withdraw approval")}</WorkspaceButton></div></div> : immutableReview.decision === "approved" && item.placement ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">{item.placement.status === "scheduled" && item.placement.verificationState === "verifying" ? t("Use Withdraw staged placement below before superseding this approval.") : t("This candidate is already active. Replace its live placement before superseding the approval.")}</p> : null}</section>;
  }
  return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="creative-review-title"><h3 className="font-semibold" id="creative-review-title">{requiresEvidenceRepair ? t("Complete missing review evidence") : t("Review decision")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{requiresEvidenceRepair ? t("The earlier immutable decision is preserved, but it cannot authorize selection without the required visible evidence. This new decision will supersede it.") : routeEvaluationReview ? t("Score identity match against the sealed Character references. Every evaluation sample requires an explicit pass or fail and a 0–100 score.") : t("Record what you observed. Decision, identity consistency, score, and visible quality remain separate facts.")}</p>{requiresEvidenceRepair && item.review ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">{t("Earlier decision:")} {item.review.decision} · {item.review.identityConsistency} · {item.review.reason}</p> : null}{characterAssetReview ? <fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="sr-only">{t("Visible quality checks")}</legend>{reviewQualityChecks.map(([key, label]) => <label className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--ad-border)] px-3 text-xs" key={key}><input checked={quality[key]} onChange={(event) => setQuality((current) => ({ ...current, [key]: event.target.checked }))} type="checkbox" /><span>{label}</span></label>)}</fieldset> : null}<div className="mt-4 grid gap-3 sm:grid-cols-[120px_180px_1fr]"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t(routeEvaluationReview ? "Identity match score" : "Score")}<input className={`${fieldClass} mt-1`} max={100} min={0} onChange={(event) => setScore(event.target.value)} placeholder={t(routeEvaluationReview ? "Required for every sample" : "Required to approve")} step={1} type="number" value={score} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Identity consistency")}<select className={`${fieldClass} mt-1`} disabled={identityReviewMode === "defines_identity"} onChange={(event) => setIdentityConsistency(event.target.value as "passed" | "failed" | "unscored")} value={identityConsistency}><option value="passed">{t("Passed")}</option><option value="failed">{t("Failed")}</option>{!routeEvaluationReview ? <option value="unscored">{identityReviewMode === "defines_identity" ? t("Unscored · defines identity") : t("Unscored")}</option> : null}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence and reason")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} placeholder={t("Describe the visible evidence behind this decision")} value={reason} /></label></div>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}{warning ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}<div className="mt-4 flex flex-wrap gap-2"><WorkspaceButton disabled={!permissions.review || !item.asset || busy || !validReason || !validScore || (characterAssetReview && !allQualityPassed) || (identityReviewMode === "defines_identity" && identityConsistency !== "unscored") || (identityReviewMode === "preserves_identity" && identityConsistency !== "passed") || (routeEvaluationReview && identityConsistency === "unscored")} onClick={() => void decide("approved")} tone="primary"><Check className="h-4 w-4" /> {requiresEvidenceRepair ? t("Record superseding approval") : t("Approve")}</WorkspaceButton><WorkspaceButton disabled={!permissions.review || !item.asset || busy || !validReason || (routeEvaluationReview && (!validScore || identityConsistency === "unscored"))} onClick={() => void decide("rejected")} tone="danger"><X className="h-4 w-4" /> {requiresEvidenceRepair ? t("Record superseding rejection") : t("Reject")}</WorkspaceButton></div>{!permissions.review ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("creative.run.review is not granted.")}</p> : null}</section>;
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
  if (!placementSupported) {
    const summary = nonCampaignReviewSummary({
      lifecycleState: run.lifecycleState,
      itemReviewed: Boolean(item.review),
    });
    return <><section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><h3 className="font-semibold">{t(summary.title)}</h3><p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">{t(summary.description)}</p></section><div className="mt-4"><CollaborationPanel canWrite={permissions.write} targetId={run.id} targetType="creative_run" targetVersion={run.version} /></div></>;
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
          {t("Staging preserves the current live image. Verification activates this candidate only after the runtime surface renders the same reviewed asset.")}
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
                placeholder={t("Explain why this reviewed asset should become the campaign candidate")}
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
              disabled={!permissions.place || !item.asset || item.review?.decision !== "approved" || busy || !targetId.trim() || !eyebrow.trim() || !campaignTitle.trim() || hasPartialCampaignCta || stageReason.trim().length < 3}
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
  const [run, setRun] = useState<CreativeRunDetail | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [backgroundRefreshWarning, setBackgroundRefreshWarning] =
    useState<string | null>(null);
  const [retrySubmitting, setRetrySubmitting] = useState(false);
  const [retryProjectionRefreshing, setRetryProjectionRefreshing] =
    useState(false);
  const [retryCommand, setRetryCommand] =
    useState<CreativeRetryCommandState | null>(
      () => readCreativeRetryCommand(id, actorId),
    );
  const retryResumeOnMount = useRef(Boolean(
    retryCommand &&
    retryCommand.commandId === null &&
    (retryCommand.status === "submitting" ||
      retryCommand.status === "submission_unknown"),
  ));
  const [retryIdempotencyKey, setRetryIdempotencyKey] = useState(
    () => retryCommand?.idempotencyKey ?? crypto.randomUUID(),
  );
  const retryCommandRef =
    useRef<CreativeRetryCommandState | null>(retryCommand);
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
  const requestGate = useRef(createLatestRequestGate());
  const load = useCallback(async (background = false, propagateError = false) => {
    const request = requestGate.current.begin();
    if (!background) setLoading(true);
    if (!background) setError(null);
    try {
      const next = await adminV2Request(`/api/v2/admin/creative/runs/${id}`, { schema: creativeRunDetailSchema });
      if (request.isCurrent()) {
        setRun(next);
        setBackgroundRefreshWarning(null);
      }
    } catch (cause) {
      if (request.isCurrent() && !background) {
        setError(cause instanceof Error ? cause.message : "Creative Run could not be loaded");
      }
      if (propagateError) throw cause;
    } finally {
      if (!background && request.isCurrent()) setLoading(false);
    }
  }, [id]);
  const reloadAfterCommit = useCallback(
    () => load(true, true),
    [load],
  );
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
      const accepted = await adminV2Request(mutation.path, {
        ...mutation.options,
        schema: adminCommandAcceptedSchema,
      });
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
  useEffect(() => {
    if (!permissions.read) return;
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load, permissions.read]);
  const shouldPollRun =
    run !== null &&
    ["pending", "running"].includes(run.executionOutcome);
  useEffect(() => {
    if (!shouldPollRun) return;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      timer = window.setTimeout(async () => {
        let nextDelay = 4_000;
        try {
          await load(true, true);
        } catch (cause) {
          nextDelay = 8_000;
          if (!cancelled) {
            setBackgroundRefreshWarning(
              cause instanceof Error
                ? `Automatic refresh was delayed: ${cause.message}. Retrying in the background.`
                : "Automatic refresh was delayed. Retrying in the background.",
            );
          }
        }
        if (!cancelled) schedule(nextDelay);
      }, delay);
    };
    schedule(4_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load, shouldPollRun]);
  const activeRetryCommandId =
    retryCommand?.commandId &&
    (retryCommand.status === "accepted" ||
      retryCommand.status === "running" ||
      retryCommand.status === "verifying")
      ? retryCommand.commandId
      : null;
  useEffect(() => {
    if (!activeRetryCommandId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const command = await adminV2Request(
          `/api/v2/admin/commands/${encodeURIComponent(activeRetryCommandId)}`,
          { schema: adminCommandStatusSchema },
        );
        if (cancelled) return;
        const current = retryCommandRef.current;
        if (
          !current ||
          current.commandId !== activeRetryCommandId
        ) {
          return;
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
            if (!cancelled) {
              retryCommandRef.current = next;
              setRetryCommand(next);
              setWarning(
                `Retry command succeeded, but the latest projection could not be refreshed${
                  cause instanceof Error ? `: ${cause.message}` : ""
                }. Refresh the projection before starting another retry.`,
              );
            }
            return;
          }
          if (cancelled) return;
          persistCreativeRetryCommand(id, actorId, null);
          retryCommandRef.current = null;
          setRetryCommand(null);
          setRetryIdempotencyKey(crypto.randomUUID());
          setWarning(null);
          return;
        }
        retryCommandRef.current = next;
        setRetryCommand(next);
        persistCreativeRetryCommand(id, actorId, next);
        if (
          command.status === "failed" ||
          command.status === "cancelled"
        ) {
          setError(creativeRetryFailureMessage(command.error));
          return;
        }
        timer = window.setTimeout(() => void poll(), 1_500);
      } catch (cause) {
        if (cancelled) return;
        setWarning(
          `Retry command ${activeRetryCommandId} is still pending, but its latest status could not be loaded${
            cause instanceof Error ? `: ${cause.message}` : ""
          }.`,
        );
        timer = window.setTimeout(() => void poll(), 3_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRetryCommandId, actorId, id, reloadAfterCommit]);
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
  if (loading && !run) return <LoadingWorkspace label="Loading Creative Run lineage and outcomes" />;
  if (!run) return <section className="rounded-xl bg-[var(--ad-red-bg)] p-5" role="alert">{error ?? t("Creative Run not found")} <button className="ml-2 underline" onClick={() => void load()} type="button">{t("Retry")}</button></section>;
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
    ? "Submitting retry…"
    : retryBusy
      ? "Retry in progress"
      : retryProjectionPending
        ? "Retry completed"
        : retrySubmissionUnknown
          ? "Resume retry submission"
          : retryFailedTerminal
            ? `Retry ${retryCount} again`
            : `Retry ${retryCount} eligible failed`;
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
  return <section aria-labelledby="creative-run-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/creative/runs"><ArrowLeft className="h-4 w-4" />  {t("Creative Runs")}</Link><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Creative Run ·")} {run.id}</p><h2 className="mt-1 text-2xl font-semibold" id="creative-run-title">{run.title}</h2><div className="mt-2 flex flex-wrap gap-2"><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Execution")}</span><StatusBadge value={run.executionOutcome} /></span><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Review")}</span><StatusBadge value={run.reviewState} /></span><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Deployment")}</span><StatusBadge value={run.deploymentState} /></span><span className="inline-flex items-center gap-1 text-xs"><span className="text-[var(--ad-text-muted)]">{t("Verification")}</span><StatusBadge value={run.verificationState} /></span></div></div><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={loading} onClick={() => void load()}><RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} /> {loading ? t("Refreshing…") : t("Refresh")}</WorkspaceButton><WorkspaceButton aria-busy={retryBusy} disabled={!permissions.write || (retryCount === 0 && !retrySubmissionUnknown) || retrying} onClick={() => void retryFailed()}><RotateCcw className={cn("h-4 w-4", retryBusy && "animate-spin")} /> {retryLabel}</WorkspaceButton></div></div>{retryCommandStatus}<IncidentAttachment permissions={permissions} reload={reloadAfterCommit} run={run} /><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">{(["generated", "failed", "reviewed", "approved", "placed"] as const).map((key) => <div className="rounded-lg bg-[var(--ad-surface)] p-3" key={key}><p className="text-xs capitalize text-[var(--ad-text-muted)]">{t(key)}</p><p className="mt-1 text-xl font-semibold tabular-nums">{run.counts[key]}<span className="text-xs font-normal text-[var(--ad-text-muted)]"> / {run.counts.total}</span></p></div>)}</div>{error ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}{backgroundRefreshWarning ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{backgroundRefreshWarning}</p> : null}{warning ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">{warning}</p> : null}<ReviewContext itemIndex={selected} run={run} /><div className="mt-5 flex gap-2 overflow-x-auto pb-2" aria-label={t("Creative items")}>{run.items.map((item, index) => <button aria-pressed={selected === index} className={cn("min-h-11 min-w-28 rounded-md border px-3 text-left text-xs focus-visible:outline focus-visible:outline-2", selected === index ? "border-[var(--ad-ink)] bg-black/[0.04]" : "border-[var(--ad-border)]")} key={item.id} onClick={() => setSelected(index)} type="button">{t("Item")} {item.ordinal + 1}<br /><span className="text-[var(--ad-text-muted)]">{t(item.executionState.replaceAll("_", " "))}</span></button>)}</div><AssetViewer onSelect={setSelected} run={run} selected={selected} /><ReviewForm itemIndex={selected} key={`review-${selectedItemId}`} onAdvance={setSelected} permissions={permissions} reload={reloadAfterCommit} run={run} /><PlacementForm itemIndex={selected} key={`placement-${selectedItemId}`} permissions={permissions} reload={reloadAfterCommit} run={run} /></section>;
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
    : <RunList actorId={actorId} key={actorId} permissions={permissions} />;
}
