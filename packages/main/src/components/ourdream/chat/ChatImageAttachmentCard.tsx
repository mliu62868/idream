"use client";

import Link from "next/link";
import { Check, ExternalLink, ImageIcon, ListChecks, Loader2, RefreshCw, Video, WandSparkles, X } from "lucide-react";
import { useState } from "react";
import type { RuntimeChatAttachment as ChatAttachment } from "@/lib/public-api-contracts";
import { generationQueueCopy } from "@/lib/generation-queue-copy";
import { unknownOutcomeCopy } from "@/lib/generation-failure-copy";
import { LegacyTestAssetBadge } from "../LegacyTestAssetBadge";
import { chatAttachmentCostLabel, chatAttachmentIsActive } from "./chat-attachments";

export function ChatImageAttachmentCard({
  attachment,
  canAddToIdentity,
  characterId,
  generateHref,
  onRetry,
  onAnimate,
  retryPending,
  onAddToIdentity,
  onIdentityMatch,
  onIdentityMismatch,
  onMoreLikeThis,
  moreLikeThisPending,
  paymentHref,
}: Readonly<{
  attachment: ChatAttachment;
  canAddToIdentity: boolean;
  characterId: string | null;
  generateHref: string | null;
  onRetry: () => void;
  onAnimate?: () => void;
  retryPending: boolean;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
  moreLikeThisPending: boolean;
  paymentHref: string;
}>) {
  const source = attachment.thumbnailUrl ?? attachment.mediaUrl;
  const previewKey = `${attachment.id}:${source ?? ""}`;
  const [invalidPreviewKey, setInvalidPreviewKey] = useState<string | null>(null);
  const invalidPreview = invalidPreviewKey === previewKey;
  const isLegacyTestAsset = attachment.isSynthetic === true;
  const costLabel = chatAttachmentCostLabel(attachment);
  const isSceneImage = attachment.imageSubject === "scene";

  if (attachment.status === "completed" && attachment.mediaUrl && source && !invalidPreview) {
    return (
      // 宽度约束必须在 figure 上：过去只有图片元素带 max-w，figure 仍撑满气泡宽度，
      // 于是图片右侧露出一大片深色底，操作条也跟着拉宽。同组件的等待/失败分支
      // 本来就是 `w-full max-w-[260px]`，这里只是漏了。
      <figure className="relative w-full max-w-[260px] overflow-hidden rounded-[12px] border border-white/10 bg-black/20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt={isSceneImage ? "Scene image from this chat" : "Character image from this chat"}
          className="aspect-[4/5] w-full object-cover"
          data-asset-id={attachment.mediaAssetId ?? undefined}
          data-testid="chat-image-attachment"
          height={attachment.height ?? 640}
          onError={() => setInvalidPreviewKey(previewKey)}
          onLoad={(event) => {
            if (isInvalidChatImagePreview(event.currentTarget)) setInvalidPreviewKey(previewKey);
          }}
          src={source}
          width={attachment.width ?? 512}
        />
        <LegacyTestAssetBadge isSynthetic={isLegacyTestAsset} />
        {costLabel ? (
          <figcaption
            className="px-2 py-1.5 text-[11px] font-bold leading-4 text-white/60"
            data-testid="chat-image-attachment-cost"
          >
            {costLabel}
          </figcaption>
        ) : null}
        {attachment.mediaAssetId ? (
          <ChatImageAttachmentActions
            canAddToIdentity={!isSceneImage && canAddToIdentity}
            characterId={isSceneImage ? null : characterId}
            generateHref={generateHref}
            onAnimate={onAnimate}
            onAddToIdentity={onAddToIdentity}
            onIdentityMatch={onIdentityMatch}
            onIdentityMismatch={onIdentityMismatch}
            onMoreLikeThis={onMoreLikeThis}
            moreLikeThisPending={moreLikeThisPending}
          />
        ) : null}
      </figure>
    );
  }

  const requiresReview = attachment.errorCode === "provider_outcome_unknown";
  const isWaiting = chatAttachmentIsActive(attachment.status, attachment.errorCode);
  const cancelled = attachment.status === "cancelled";
  const failed = ["failed", "blocked", "refunded", "rejected"].includes(attachment.status);
  const canRetry = Boolean(attachment.generationJobId) && attachment.canRetry !== false && ["failed", "refunded"].includes(attachment.status);
  const paymentRequired = failed && attachment.errorCode === "payment_required";
  // Main's active-job cap, not a broken image: nothing was charged or queued.
  const tooManyActive = failed && attachment.errorCode === "rate_limited";
  const completedUnavailable = attachment.status === "completed" && Boolean(attachment.mediaAssetId);
  // Only a request that reached a job was charged; a failed one is refunded in
  // full and an unconfirmed one is held, so the card says which.
  const chargedCost = (attachment.generationJobId || attachment.status === "accepted" || attachment.status === "refunded")
    && typeof attachment.costDreamcoins === "number" && attachment.costDreamcoins > 0
    ? attachment.costDreamcoins : 0;
  const refundableCost = chargedCost ? `${chargedCost} ${chargedCost === 1 ? "coin" : "coins"}` : null;
  const queueCopy = generationQueueCopy({ mode: "image", queueAhead: attachment.queueAhead, queueEtaSeconds: attachment.queueEtaSeconds });
  return (
    <div
      className="w-full max-w-[260px] rounded-[12px] border border-white/10 bg-black/20 p-3"
      data-testid="chat-image-attachment-card"
    >
      <div className="flex items-start gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white">
          {isWaiting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-white">
            {requiresReview
              ? "Image result not confirmed yet"
              : cancelled
                ? "Image cancelled"
              : paymentRequired
                ? "Not enough dreamcoins"
              : tooManyActive
                ? "Too many images in progress"
              : failed || attachment.status === "proposed" || completedUnavailable
                ? "Image unavailable"
              : attachment.deliveryStage === "sending"
                ? "Sending photo…"
                : "Generating image"}
          </p>
          {completedUnavailable ? (
            <div
              className="mt-2 flex flex-col items-start gap-1 text-[11px] leading-4 text-white/60"
              data-testid="chat-image-preview-fallback"
            >
              <span className="font-bold text-white/80">Preview unavailable</span>
              <span className="line-clamp-2">
                The image is ready, but its preview could not be loaded.
              </span>
            </div>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/60">
              {requiresReview
                ? unknownOutcomeCopy(chargedCost)
                : cancelled
                ? attachment.generationJobId ? "This image request was cancelled. Check your Dreamcoin history for refund details." : "Cancelled before editing. No coins used."
                : failed || attachment.status === "proposed"
                ? paymentRequired
                  ? "Add dreamcoins to generate this image."
                  : tooManyActive
                  ? "Wait for one to finish, then ask again. No coins used."
                  : `The image could not be completed.${refundableCost ? ` Your ${refundableCost} were returned.` : ""} ${canRetry ? "Retry uses the current image price." : attachment.canRetry === false && attachment.errorCode === "preparation_failed" ? "Change the source image or instructions and send a new request." : "You can send a new image request in this chat."}`
                : "Your image is being prepared. You can keep chatting while it finishes."}
            </p>
          )}
          {isWaiting && !requiresReview && queueCopy ? (
            <p className="mt-1 text-[11px] font-bold leading-4 text-white/70" data-testid="chat-image-queue">
              {queueCopy}
            </p>
          ) : null}
          {costLabel ? (
            <p
              className="mt-1 text-[11px] font-bold leading-4 text-white/70"
              data-testid="chat-image-attachment-cost"
            >
              {costLabel}
            </p>
          ) : null}
        </div>
      </div>
      {requiresReview ? (
        <div className="mt-3 text-[11px] text-white/70">
          <p className="break-all">Request: {attachment.generationJobId ?? attachment.id}</p>
        </div>
      ) : paymentRequired ? (
        <Link
          className="mt-3 inline-flex h-8 items-center rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)]"
          href={paymentHref}
        >
          Get more dreamcoins
        </Link>
      ) : canRetry ? (
        <button
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)] disabled:opacity-70"
          disabled={retryPending}
          onClick={onRetry}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {retryPending ? "Checking image request…" : "Retry image"}
        </button>
      ) : null}
      {completedUnavailable ? (
        <ChatImageAttachmentActions
          canAddToIdentity={!isSceneImage && canAddToIdentity}
          characterId={isSceneImage ? null : characterId}
          generateHref={generateHref}
          onAnimate={onAnimate}
          onAddToIdentity={onAddToIdentity}
          onIdentityMatch={onIdentityMatch}
          onIdentityMismatch={onIdentityMismatch}
          onMoreLikeThis={onMoreLikeThis}
          moreLikeThisPending={moreLikeThisPending}
        />
      ) : null}
    </div>
  );
}

function ChatImageAttachmentActions({
  canAddToIdentity,
  characterId,
  generateHref,
  onAnimate,
  onAddToIdentity,
  onIdentityMatch,
  onIdentityMismatch,
  onMoreLikeThis,
  moreLikeThisPending,
}: Readonly<{
  canAddToIdentity: boolean;
  characterId: string | null;
  generateHref: string | null;
  onAnimate?: () => void;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
  moreLikeThisPending: boolean;
}>) {
  return (
    <div className="grid gap-2 border-t border-white/10 p-2">
      {/* 单列：卡片收窄到 260px 后，两列会让「Looks like them」在固定 h-8 的按钮里折行溢出。 */}
      {characterId ? <div className="grid grid-cols-1 gap-2" aria-label="Character identity feedback">
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-400/15 px-3 text-[11px] font-bold text-emerald-100"
          onClick={onIdentityMatch}
          type="button"
        >
          <Check className="h-3.5 w-3.5" />
          Looks like them
        </button>
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-rose-400/15 px-3 text-[11px] font-bold text-rose-100"
          onClick={onIdentityMismatch}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
          Doesn&apos;t match
        </button>
      </div> : null}
      <div className={`grid gap-2 ${canAddToIdentity ? "grid-cols-2" : "grid-cols-1"}`}>
        {/* Two narrow columns wrap these labels; grow instead of clipping them. */}
        <button
          className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-center text-[11px] leading-tight font-black text-[rgb(13,13,13)]"
          disabled={moreLikeThisPending}
          onClick={onMoreLikeThis}
          type="button"
        >
          {moreLikeThisPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <WandSparkles className="h-3.5 w-3.5" />
          )}
          {moreLikeThisPending
            ? "Checking price…"
            : "More like this"}
        </button>
        {canAddToIdentity && (
          <button
            className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-center text-[11px] leading-tight font-bold text-white"
            onClick={onAddToIdentity}
            type="button"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Use for identity
          </button>
        )}
      </div>
      {generateHref ? <Link
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-black/30 px-3 text-[11px] font-bold text-white"
        href={generateHref}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Generate
      </Link> : null}
      {onAnimate ? <button type="button" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-white/10 px-3 text-xs font-bold text-white" onClick={onAnimate}><Video className="size-4" />Animate</button> : null}
    </div>
  );
}

function isInvalidChatImagePreview(image: HTMLImageElement) {
  if (image.naturalWidth <= 1 || image.naturalHeight <= 1) return true;
  return isBlankChatImagePreview(image);
}

function isBlankChatImagePreview(image: HTMLImageElement) {
  const width = Math.min(16, image.naturalWidth);
  const height = Math.min(16, image.naturalHeight);
  if (width <= 0 || height <= 0) return false;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
    }

    const range = max - min;
    return range <= 1 || (range <= 4 && (min >= 250 || max <= 5));
  } catch {
    return false;
  }
}
