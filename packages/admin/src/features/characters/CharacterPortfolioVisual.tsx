"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { ImageIcon } from "lucide-react";

export function CharacterPortfolioVisual({
  canOpenAssets,
  eager = false,
  linkToAssets = true,
  name,
  variant = "compact",
  visualProduction,
}: {
  canOpenAssets: boolean;
  eager?: boolean;
  linkToAssets?: boolean;
  name: string;
  variant?: "compact" | "featured" | "tile";
  visualProduction: CharacterPortfolioItem["visualProduction"];
}) {
  const { t } = useAdminI18n();
  const draftCount = visualProduction.draftPurposes.length;
  const liveCount = visualProduction.livePurposes.length;
  const canRenderPrimaryImage =
    visualProduction.primaryImageUrl !== null &&
    (canOpenAssets || visualProduction.primaryImageSource !== "draft");
  const mediaClassName =
    variant === "featured"
      ? "relative min-h-[320px] overflow-hidden bg-black/[0.04] sm:min-h-[360px]"
      : variant === "tile"
        ? "relative aspect-[4/5] w-full overflow-hidden rounded-lg bg-black/[0.04]"
        : "relative h-20 w-20 overflow-hidden rounded-lg bg-black/[0.04]";
  const content = (
    <>
      <div className={mediaClassName}>
        {canRenderPrimaryImage ? (
          <Image
            alt={t("{name} primary role portrait", { name })}
            className="h-full w-full object-cover"
            height={variant === "compact" ? 80 : 640}
            loading={eager ? "eager" : "lazy"}
            src={visualProduction.primaryImageUrl as string}
            unoptimized
            width={variant === "compact" ? 80 : 720}
          />
        ) : (
          <div className="grid h-full min-h-20 w-full place-items-center text-[var(--ad-text-muted)]">
            <div className="flex flex-col items-center gap-2">
              <ImageIcon
                aria-hidden="true"
                className={variant === "compact" ? "h-5 w-5" : "h-8 w-8"}
              />
              <span
                className={
                  variant === "compact" ? "sr-only" : "text-xs font-semibold"
                }
              >
                {t("No primary role portrait")}
              </span>
            </div>
          </div>
        )}
        {variant === "compact" &&
        canRenderPrimaryImage &&
        visualProduction.primaryImageSource ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {visualProduction.primaryImageSource === "draft"
              ? t("Draft portrait")
              : t("Live portrait")}
          </span>
        ) : null}
      </div>
      {variant === "compact" ? (
        <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">
          {t("Draft")} {draftCount} {t("of 3")}
          <span aria-hidden="true"> · </span>
          <span>
            {t("Live")} {liveCount} {t("of 3")}
          </span>
        </p>
      ) : null}
    </>
  );
  const className =
    variant === "compact"
      ? "block w-24 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
      : "block h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--ad-ink)]";
  return canOpenAssets && linkToAssets ? (
    <Link
      aria-label={t(
        "{name}: open role-image assets, Draft {draftCount} of 3, Live {liveCount} of 3",
        { name, draftCount, liveCount },
      )}
      className={`${className} hover:opacity-90`}
      href={visualProduction.deepLink}
    >
      {content}
    </Link>
  ) : (
    <div
      className={
        variant === "compact"
          ? "w-24"
          : variant === "featured"
            ? "h-full w-full"
            : "w-full"
      }
    >
      {content}
    </div>
  );
}
