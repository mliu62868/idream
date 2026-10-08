"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { INPUT_CLASS } from "@/components/admin/ui/FormPage";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";
import { InfoGrid, WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import {
  PATCH_ACTIONS,
  PLACEMENTS_BASE,
  placementPatchPayload,
  validCampaignDraft,
  type PlacementDraft,
  type Placement,
} from "./placements-api";

// Publication is a separate byte-verifying command; a status PATCH cannot bypass it.
type PendingAction = (typeof PATCH_ACTIONS)[number] | "publish" | "copy" | null;

export function PlacementsDetailPage({ canPublish, id }: { canPublish: boolean; id: string }) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [copy, setCopy] = useState<Pick<PlacementDraft, "eyebrow" | "title" | "ctaLabel" | "href"> | null>(null);
  const [writePermission, setWritePermission] = useState(canPublish);
  // Revocation discards the write intent itself, so regrant cannot revive an
  // earlier draft or a filled publication confirmation.
  if (writePermission !== canPublish) {
    setWritePermission(canPublish);
    if (!canPublish) {
      setCopy(null);
      setPending(null);
    }
  }
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();

  const reload = useCallback(async (propagateError = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ placement: Placement }>(`${PLACEMENTS_BASE}/${encodeURIComponent(id)}`);
      setRows([data.placement]);
      setRefreshWarning(null);
    } catch (loadError) {
      setError(requestErrorMessage(loadError, t));
      if (propagateError) throw loadError;
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useWorkspaceRefresh(reload);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);
  const { guard } = useUnsavedChanges(Boolean(copy &&
    (["eyebrow", "title", "ctaLabel", "href"] as const).some(key => copy[key] !== String(row?.metadata?.[key] ?? ""))));

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!canPublish || !row || !pending || (pending === "copy" && !copy)) return null;
    if (pending === "copy" && copy) return {
      title: t("Save changes"), submitLabel: t("Save changes"),
      onSubmit: async (reason) => {
        await adminV2Operation("PATCH /api/v2/admin/content/placements/:id", {
          path: { id }, ifMatch: row.version, body: { confirmation: id, reason, metadata: {
            eyebrow: copy.eyebrow.trim(), title: copy.title.trim(),
            ctaLabel: copy.ctaLabel.trim() || null, href: copy.href.trim() || null,
          } },
        });
        setCopy(null);
        reportSuccess(t("Campaign copy saved. Publish to make it visible in Community."));
        try { await reload(true); }
        catch (refreshError) {
          setError(null);
          setRefreshWarning(t("Placement copy was saved, but the latest projection could not be refreshed: {message}. Use Refresh before another write.", { message: requestErrorMessage(refreshError, t) }));
        }
      },
    };
    if (pending === "publish") return {
      title: t("Publish"), submitLabel: t("Publish"),
      summary: t("This campaign will become visible in Community. You can pause it from this page."),
      onSubmit: async (reason) => {
        await adminV2Operation("POST /api/v2/admin/content/placements/:id/publish", {
          path: { id }, ifMatch: row.version, body: { reason, confirmation: id },
        });
        reportSuccess(t("Published. This campaign is visible in Community."));
        try { await reload(true); }
        catch (refreshError) {
          setError(null);
          setRefreshWarning(t("Placement publication was committed, but the latest projection could not be refreshed: {message}. Use Refresh before another write.", { message: requestErrorMessage(refreshError, t) }));
        }
      },
    };
    if (pending === "paused") {
      return {
        title: t("Pause"),
        submitLabel: t("Pause"),
        onSubmit: async (reason) => {
          await adminV2Operation("PATCH /api/v2/admin/content/placements/:id", {
            path: { id },
            ifMatch: row.version,
            body: placementPatchPayload(id, "paused", reason),
          });
          reportSuccess(t("Paused. {slot} stops serving immediately.", { slot: value(row.slot) }));
          try {
            await reload(true);
          } catch (refreshError) {
            setError(null);
            setRefreshWarning(
              refreshError instanceof Error
                ? t("Placement pause was committed, but the latest projection could not be refreshed: {message}. Use Refresh before another write.", { message: refreshError.message })
                : t("Placement pause was committed, but the latest projection could not be refreshed. Use Refresh before another write."),
            );
          }
        },
      };
    }
    return {
      title: t("Archive"),
      destructive: { expectedName: row.slot },
      submitLabel: t("Archive"),
      onSubmit: async (reason) => {
        await adminV2Operation("PATCH /api/v2/admin/content/placements/:id", {
          path: { id },
          ifMatch: row.version,
          body: placementPatchPayload(id, "archived", reason),
        });
        reportSuccess(t("Archived. {slot} is retired and will not serve again.", { slot: value(row.slot) }));
        try {
          await reload(true);
          } catch (refreshError) {
            setError(null);
            setRefreshWarning(
              refreshError instanceof Error
              ? t("Placement archival was committed, but the latest projection could not be refreshed: {message}. Use Refresh before another write.", { message: refreshError.message })
              : t("Placement archival was committed, but the latest projection could not be refreshed. Use Refresh before another write."),
            );
        }
      },
    };
  }, [canPublish, pending, row, id, t, value, reload, reportSuccess, copy]);

  if (loading && !row) {
    return <>{guard}<LoadingWorkspace label="Loading…" /></>;
  }

  if (!row) {
    if (error) {
      return (
        <div className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}{" "}
          <button className="font-semibold underline" onClick={() => void reload()} type="button">
            {t("Retry")}
          </button>
        </div>
      );
    }
    return (
      <EmptyState
        action={
            <Link href="/admin/creative/placements">
            <PrimaryButton>{t("Back to placements")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Placement not found.")}
      />
    );
  }

  const canPause = canPublish &&
    !row.managedRunId &&
    !["paused", "archived"].includes(row.status);
  const canArchive = canPublish &&
    !row.managedRunId &&
    row.status !== "archived";
  const canPublishArtwork = canPublish && row.canPublish && !copy;
  const canEditCopy = canPublish && !row.managedRunId && row.slot === "campaign" && ["draft", "paused"].includes(row.status);
  const actions = canPublishArtwork || canPause || canArchive || refreshWarning ? (
    <>
      {refreshWarning ? <GhostButton onClick={() => void reload()}>{t("Refresh")}</GhostButton> : null}
      {canPublishArtwork ? <PrimaryButton disabled={Boolean(refreshWarning)} onClick={() => setPending("publish")}>{t("Publish")}</PrimaryButton> : null}
      {canPause ? <GhostButton disabled={Boolean(refreshWarning)} onClick={() => setPending("paused")}>{t("Pause")}</GhostButton> : null}
      {canArchive ? <DangerButton disabled={Boolean(refreshWarning)} onClick={() => setPending("archived")}>{t("Archive")}</DangerButton> : null}
    </>
  ) : null;

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/creative/placements"
      backLabel={t("Back to placements")}
      status={row.status}
      title={value(row.slot)}
    >
      {guard}
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {refreshWarning ? <p role="status" className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">{refreshWarning}</p> : null}

      {row.managedRunId ? (
        <div className="rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm text-[var(--ad-blue-text)]">
          {t("This placement is managed by Creative Run verification and is read-only here.")}{" "}
          <Link className="font-semibold underline" href={`/admin/creative/runs/${row.managedRunId}`}>
            {t("Open Creative Run")}
          </Link>
        </div>
      ) : null}

      {/* SPEC: 草稿铺位上没有"上线"按钮，就得在这一页说清楚上线权在谁手里、下一步去哪。 */}
      {/* INTENT: 这条规则以前只写在列表页顶部的横幅上，从列表点进详情后它就消失了 ——
          运营在详情页只看到「暂停 / 归档」，无从知道为什么没有发布按钮。 */}
      {!row.managedRunId && row.status === "draft" && !row.canPublish ? (
        <div className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
          {t(row.slot === "campaign"
            ? "Uploaded Campaigns need valid copy and an approved image. Generated campaigns publish from their Creative Run."
            : "This slot has no customer-facing renderer. It can be saved as a draft only.")}{" "}
          {row.targetType === "character" ? (
            <Link className="font-semibold underline" href={`/admin/characters/${row.targetId}?tab=release`}>
              {t("Open this Character's release")}
            </Link>
          ) : (
            <Link className="font-semibold underline" href="/admin/creative/runs">
              {t("Open Creative Runs")}
            </Link>
          )}
        </div>
      ) : null}

      <AssetImage asset={row.asset} preview />
      {row.slot === "campaign" ? <DetailSection title={t("Campaign")}>{canPublish && copy ? <div className="grid gap-3 sm:grid-cols-2">
        {([
          ["eyebrow", "Campaign eyebrow", 80], ["title", "Campaign title", 120],
          ["ctaLabel", "Campaign CTA label", 60], ["href", "Campaign CTA href", 512],
        ] as const).map(([key, label, maxLength]) => <label key={key} className="grid gap-1 text-sm">{t(label)}<input aria-label={t(label)} className={INPUT_CLASS} maxLength={maxLength} value={copy[key]} onChange={event => setCopy({ ...copy, [key]: event.target.value })} /></label>)}
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Add both a CTA label and destination, or leave both blank.")}</p>
        <div className="flex gap-2"><GhostButton onClick={() => { setCopy(null); setPending(null); }}>{t("Cancel")}</GhostButton><PrimaryButton disabled={Boolean(refreshWarning) || !validCampaignDraft({ ...copy, slot: "campaign", targetType: "campaign" })} onClick={() => setPending("copy")}>{t("Save changes")}</PrimaryButton></div>
      </div> : <><InfoGrid items={[
        { label: t("Campaign eyebrow"), value: String(row.metadata?.eyebrow ?? "—") },
        { label: t("Campaign title"), value: String(row.metadata?.title ?? "—") },
        { label: t("Campaign CTA label"), value: String(row.metadata?.ctaLabel ?? "—") },
        { label: t("Campaign CTA href"), value: String(row.metadata?.href ?? "—") },
      ]} />{canEditCopy ? <GhostButton disabled={Boolean(refreshWarning)} onClick={() => setCopy({
        eyebrow: String(row.metadata?.eyebrow ?? ""), title: String(row.metadata?.title ?? ""),
        ctaLabel: String(row.metadata?.ctaLabel ?? ""), href: String(row.metadata?.href ?? ""),
      })}>{t("Edit")}</GhostButton> : null}</>}</DetailSection> : null}

      <DetailSection title={t("Basic info")}>
        <InfoGrid
          items={[
            { label: t("Slot"), value: value(row.slot) },
            { label: t("Target type"), value: value(row.targetType) },
            { label: t("Target ID"), value: row.targetId },
            { label: t("Verification"), value: value(row.verificationState) },
            { label: t("Published"), value: row.publishedAt ? format.dateTime(row.publishedAt) : "—" },
          ]}
        />
      </DetailSection>

      <EngineeringDetails summary={t("Placement details")}>
        <div>{t("Placement ID")}: {row.id}</div>
        <div>{t("Media asset")}: {row.mediaAssetId}</div>
      </EngineeringDetails>

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
