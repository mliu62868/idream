"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { characterHasNoUnpublishedChanges } from "./character-workspace-format";

const previewChangeLabels: Record<string, string> = {
  new_release: "First release",
  name: "Character name",
  description: "Description",
  persona: "Persona",
  opening: "Opening message",
  appearance: "Appearance",
  imageUrl: "Cover image",
  assetPack: "Image pack",
};

export function releasePreviewChangeSummary(changedFields: readonly string[]) {
  return {
    firstRelease: changedFields.includes("new_release"),
    labels: changedFields.map(
      (field) => previewChangeLabels[field] ?? field.replaceAll("_", " "),
    ),
  };
}

function ReleaseChangeSummary({
  changedFields,
}: {
  changedFields: readonly string[];
}) {
  const { t } = useAdminI18n();
  const summary = releasePreviewChangeSummary(changedFields);
  const message = summary.firstRelease
    ? "First release — nothing is live yet."
    : summary.labels.length
      ? "{count} areas differ from Live."
      : "No draft changes detected.";
  return (
    <section
      aria-labelledby="release-change-summary-title"
      className="mb-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      data-testid="release-change-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" id="release-change-summary-title">
          {t("Release change summary")}
        </h2>
        <span className="text-xs font-semibold tabular-nums text-[var(--ad-text-muted)]">
          {summary.labels.length}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
        {t(message, { count: summary.labels.length })}
      </p>
      {summary.labels.length ? (
        <div
          className="mt-3 flex flex-wrap gap-2"
          aria-label={t("Changed fields")}
        >
          {summary.labels.map((label) => (
            <StatusBadge key={label} tone="warn" value={label} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function PreviewDiff({ data }: { data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const snapshots = [data.preview.live, data.preview.draft].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  const previewReady =
    data.project.draftAssetRouteAuthority.releaseReady &&
    data.preview.draft.assetPackReady;
  const draftAssetPackIsStale =
    data.project.draftAssetRouteAuthority.releaseBlockers.includes(
      "draft_asset_generation_route_stale",
    );
  if (characterHasNoUnpublishedChanges(data)) {
    return (
      <section
        className="border-y border-[var(--ad-border)] py-5"
        role="status"
      >
        <h2 className="font-semibold">{t("Live and draft are identical")}</h2>
        <p className="mt-1 text-sm leading-6 text-[var(--ad-text-muted)]">
          {t(
            "There are no unpublished changes. Nothing needs review or release.",
          )}
        </p>
      </section>
    );
  }
  if (!previewReady) {
    return (
      <div className="space-y-5">
        <section
          aria-labelledby="launch-preview-next-action"
          className="flex flex-col gap-4 rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] p-4 text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h2 className="font-semibold" id="launch-preview-next-action">
              {t("Launch preview is waiting for the image pack")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6">
              {t(
                draftAssetPackIsStale
                  ? "Regenerate the stale image selections under the current route, then return here to compare live and draft."
                  : "Complete the cover, hero, and chat images under the current route, then return here to compare live and draft.",
              )}
            </p>
          </div>
          <Link
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-current px-3 text-sm font-semibold"
            href={`/admin/characters/${data.character.id}?tab=assets`}
          >
            {t(
              draftAssetPackIsStale
                ? "Regenerate current image pack"
                : "Complete image assets",
            )}
          </Link>
        </section>

        <section aria-labelledby="blocked-preview-comparison">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold" id="blocked-preview-comparison">
              {t("Current and draft assets")}
            </h2>
          </div>
          <ReleaseChangeSummary changedFields={data.preview.changedFields} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {snapshots.map((snapshot) => {
              const cover = snapshot.assetPack.character_cover;
              // SPEC: 完成度只读服务端 journey 投影，不数 preview 快照的槽位。
              // INTENT: preview.draft.assetPack 没做路线过滤，数出来的「齐了」和上面那条
              // 「图池 0/3」告警来自两套口径，同一屏能并存两个互相打脸的结论。
              const missing = (
                snapshot.label === "Live"
                  ? data.journey.assetPack.live
                  : data.journey.assetPack.draft
              ).missingPurposes.length;
              return (
                <article
                  className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3"
                  key={snapshot.label}
                >
                  <figure className="aspect-[4/5] overflow-hidden rounded-md bg-black/[0.04]">
                    {cover.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
                      <img
                        alt={t("{name} {snapshot}", {
                          name: snapshot.name,
                          snapshot: t(snapshot.label),
                        })}
                        className="h-full w-full object-cover"
                        src={cover.imageUrl}
                      />
                    ) : null}
                  </figure>
                  <div className="min-w-0">
                    <strong className="text-sm">{t(snapshot.label)}</strong>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                      {missing === 0
                        ? t("Image pack complete")
                        : t("{count} image slots missing", { count: missing })}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  }
  return (
    <div>
      <ReleaseChangeSummary changedFields={data.preview.changedFields} />
      {previewReady ? (
        <section aria-labelledby="real-renderer-preview-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="font-semibold" id="real-renderer-preview-title">
                {t("Real user-surface renderer")}
              </h2>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {t(
                  "Short-lived signed snapshots render in main without mutating Serving, chats, or assets.",
                )}
              </p>
            </div>
            <StatusBadge value="read only" />
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {snapshots.map((snapshot) => (
              <article
                className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
                key={`renderer-${snapshot.label}`}
              >
                <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-4 py-3">
                  <strong className="text-xs uppercase tracking-wide">
                    {t(snapshot.label)}
                  </strong>
                  <span className="text-xs text-[var(--ad-text-muted)]">
                    {t("Desktop + responsive mobile layout")}
                  </span>
                </div>
                {snapshot.renderUrl ? (
                  <iframe
                    className="h-[760px] w-full bg-[rgb(13,13,13)]"
                    loading="lazy"
                    sandbox="allow-scripts allow-same-origin"
                    src={snapshot.renderUrl}
                    title={t("{label} real frontend renderer", {
                      label: t(snapshot.label),
                    })}
                  />
                ) : (
                  <div className="p-6 text-sm text-[var(--ad-text-muted)]">
                    {snapshot.contentVersionId
                      ? t(
                          "Renderer unavailable: avatar, hero, and chat must each resolve to their exact operational asset.",
                        )
                      : t(
                          "Renderer unavailable until an immutable ContentVersion exists.",
                        )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <details className="mt-5 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer p-4 font-semibold">
          {t("Current and draft assets")}
        </summary>
        <div className="grid gap-4 border-t border-[var(--ad-border)] p-4 lg:grid-cols-2">
          {snapshots.map((snapshot) => (
            <article
              className={cn(
                "overflow-hidden rounded-xl border bg-[var(--ad-surface)]",
                snapshot.label === "Draft Preview"
                  ? "border-[var(--ad-yellow-text)]"
                  : "border-[var(--ad-border)]",
              )}
              key={snapshot.label}
            >
              <div className="border-b border-[var(--ad-border)] px-4 py-3 text-xs font-semibold uppercase tracking-wide">
                {t(snapshot.label)}
              </div>
              <div className="p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["character_cover", "Avatar / discovery", "aspect-[4/5]"],
                      ["character_hero", "Character hero", "aspect-video"],
                      ["character_chat", "Chat image", "aspect-[4/5]"],
                    ] as const
                  ).map(([purpose, label, aspect]) => {
                    const slot = snapshot.assetPack[purpose];
                    return (
                      <figure
                        className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.04]"
                        key={purpose}
                      >
                        <div
                          className={cn(
                            "grid place-items-center overflow-hidden",
                            aspect,
                          )}
                        >
                          {slot.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
                            <img
                              alt={t("{name} {slot} {snapshot}", {
                                name: snapshot.name,
                                slot: t(label),
                                snapshot: t(snapshot.label),
                              })}
                              className="h-full w-full object-cover"
                              src={slot.imageUrl}
                            />
                          ) : (
                            <span className="px-3 text-center text-xs font-semibold text-[var(--ad-text-muted)]">
                              {slot.status === "missing"
                                ? t("{label} not selected", { label: t(label) })
                                : t("{label} unavailable", { label: t(label) })}
                            </span>
                          )}
                        </div>
                        <figcaption className="border-t border-[var(--ad-border)] px-3 py-2 text-[11px]">
                          <strong>{t(label)}</strong>
                          <span className="mt-0.5 block break-all text-[var(--ad-text-muted)]">
                            {slot.assetId ?? t("No asset ID")}
                          </span>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
                <div className="mt-4">
                  <h3 className="text-lg font-semibold">{snapshot.name}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">
                    {snapshot.description}
                  </p>
                  <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide">
                    {t("Opening")}
                  </h4>
                  <p className="mt-2 text-sm">
                    {String(snapshot.opening.firstMessage ?? t("Unavailable"))}
                  </p>
                  <details className="mt-5 text-xs">
                    <summary className="cursor-pointer font-semibold">
                      {t("Immutable evidence")}
                    </summary>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-black/[0.04] p-3">
                      {JSON.stringify(
                        {
                          releaseId: snapshot.releaseId,
                          contentVersionId: snapshot.contentVersionId,
                          assetPack: snapshot.assetPack,
                          persona: snapshot.persona,
                          appearance: snapshot.appearance,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              </div>
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}
