"use client";

import { useCallback, useState } from "react";
import type { CharacterOperationsSummary } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { cn } from "@/lib/utils";
import { percent } from "./character-workspace-format";

const NONE = "None yet";

function hoursLabel(hours: number | null) {
  if (hours === null) return NONE;
  return hours >= 48 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`;
}

// SPEC: 运营效能的显示规则。null 显示「暂无」，不写 0。
export function characterOperationsSummaryRows(summary: CharacterOperationsSummary) {
  const cost = summary.adoptedImageCost;
  return [
    { label: "Time to first usable image", value: hoursLabel(summary.firstUsableImage.medianHours), note: null },
    { label: "Creation to first publish", value: hoursLabel(summary.createToFirstPublish.medianHours), note: null },
    {
      label: "Image adoption",
      value: summary.imageAdoption.rate === null ? NONE : percent(summary.imageAdoption.rate),
      note: summary.imageAdoption.generated > 0 ? "{adopted} of {generated} generated images" : null,
    },
    {
      label: "Real cost per adopted image",
      value: cost.microsPerAdoptedImage === null ? NONE : `$${(cost.microsPerAdoptedImage / 1_000_000).toFixed(2)}`,
      note: cost.coverage === "partial" ? "Some calls have no real cost yet" : null,
    },
    {
      label: "Publish failures",
      value: String(summary.publishFailures.count),
      note: "Committed publish failures only",
    },
    { label: "Operations", value: String(summary.operationCount), note: null },
  ] as const;
}

export function CharacterOperationsSummaryPanel({ canRead }: { canRead: boolean }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [window, setWindow] = useState<"7d" | "28d">("7d");
  const resource = useAuthorityResource({
    key: window,
    enabled: canRead,
    load: useCallback(
      () =>
        adminV2Operation("GET /api/v2/admin/characters/performance/operations-summary", {
          query: `window=${window}`,
        }),
      [window],
    ),
  });
  const summary = resource.data;
  return (
    <section aria-labelledby="character-operations-summary" className="mt-6 border-t border-[var(--ad-border)] pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold" id="character-operations-summary">{t("Operating efficiency")}</h3>
        <div aria-label={t("Efficiency window")} className="inline-flex rounded-md border border-[var(--ad-border)]" role="group">
          {(["7d", "28d"] as const).map((value) => (
            <button
              aria-pressed={window === value}
              className={cn(
                "min-h-8 px-3 text-xs font-medium",
                window === value ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]" : "text-[var(--ad-text-muted)]",
              )}
              key={value}
              onClick={() => setWindow(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {resource.error ? (
        <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{resource.error}</p>
      ) : summary ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-6">
          {characterOperationsSummaryRows(summary).map((row) => (
            <div key={row.label}>
              <dt className="text-xs text-[var(--ad-text-muted)]">{t(row.label)}</dt>
              <dd className="mt-0.5 text-sm font-semibold">{t(row.value)}</dd>
              {row.note ? (
                <dd className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
                  {t(row.note, {
                    adopted: format.count(summary.imageAdoption.adopted),
                    generated: format.count(summary.imageAdoption.generated),
                  })}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[var(--ad-text-muted)]" role="status">{t("Loading")}</p>
      )}
    </section>
  );
}
