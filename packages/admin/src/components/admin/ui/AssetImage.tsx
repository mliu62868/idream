"use client";
import Image from "next/image";
import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";

// SPEC: 列表优先缩略图；详情预览显示完整原图并限制高度，让素材信息留在首屏。
// INTENT: ui/ 原语只依赖结构类型（url/thumbnailUrl），不耦合具体资产 DTO，供图片库列表卡片/详情大图、
// 铺位历史、生产复核网格共用。
export type AssetImageSource = {
  url: string;
  thumbnailUrl: string;
};

export function AssetImage({
  asset,
  compact = false,
  eager = false,
  preview = false,
}: {
  asset: AssetImageSource;
  compact?: boolean;
  eager?: boolean;
  /** Detail previews show the complete original within a bounded height. */
  preview?: boolean;
}) {
  const { t } = useAdminI18n();
  const imageSrc = preview ? asset.url || asset.thumbnailUrl : asset.thumbnailUrl || asset.url;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hasFailed = failedSrc === imageSrc;

  return (
    <div className={cn("relative overflow-hidden bg-black/[0.03]", preview ? "h-[min(50vh,28rem)] w-full rounded-lg" : compact ? "h-24 w-24" : "aspect-[4/5]")}>
      {hasFailed ? (
        <div className="grid h-full w-full place-items-center gap-2 p-3 text-center text-xs text-[var(--ad-text-muted)]">
          <div>
            <ImageIcon className="mx-auto mb-2 h-5 w-5" />
            {compact ? t("Missing") : t("Missing asset")}
          </div>
        </div>
      ) : (
        <Image
          alt=""
          fill
          className={cn("h-full w-full", preview ? "object-contain" : "object-cover")}
          loading={eager ? "eager" : undefined}
          onError={() => setFailedSrc(imageSrc)}
          sizes={preview ? "(min-width: 1024px) 75vw, 100vw" : compact ? "96px" : "(min-width: 1280px) 25vw, (min-width: 768px) 50vw, 100vw"}
          src={imageSrc}
          unoptimized
        />
      )}
    </div>
  );
}
