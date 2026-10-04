"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { isBuiltInMediaPlaceholderUrl } from "@/lib/image-delivery";

type VideoSource = {
  url: string;
  thumbnailUrl?: string | null;
  contentType?: string | null;
};

// SPEC: 图库卡片里的视频预览。
// INTENT: 视频资产没有服务端封面（thumbnailUrl 与 url 相同），过去 preload="none"
//   让卡片只剩黑底加载圈。没有真封面时改为预取元数据并定位到首帧，让浏览器画出首帧当封面；
//   有真封面时仍不预取，避免一屏视频全部开始下载。
export function VideoPreview({
  className = "h-full w-full object-contain",
  item,
  label,
  onError,
  testId,
}: {
  className?: string;
  item: VideoSource;
  label: string;
  onError?: () => void;
  testId?: string;
}) {
  const poster = item.thumbnailUrl && item.thumbnailUrl !== item.url && !isBuiltInMediaPlaceholderUrl(item.thumbnailUrl)
    ? item.thumbnailUrl
    : undefined;
  return (
    <video
      aria-label={label}
      className={className}
      controls
      data-testid={testId}
      onError={onError}
      playsInline
      poster={poster}
      preload={poster ? "none" : "metadata"}
    >
      <source onError={onError} src={poster ? item.url : `${item.url}#t=0.001`} type={item.contentType ?? "video/mp4"} />
      Video playback is not supported.
    </video>
  );
}

export type LightboxMedia = VideoSource & {
  type: "image" | "video";
  alt: string;
};

// SPEC: 图库大图 / 视频查看。原生 <dialog>.showModal() 提供焦点困在弹窗内、背景 inert
//   与 Esc；关闭后焦点回到打开它的按钮。点遮罩或关闭按钮关闭。
// INTENT: 项目里没有带焦点管理的弹窗原语（ReportDialog 是手写 div），这里用平台能力
//   而不是再写一套焦点陷阱。
export function MediaLightbox({ media, onClose }: { media: LightboxMedia; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    // Read the opener before moving focus into the dialog (so no autoFocus).
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      aria-label={media.alt}
      className="m-auto max-h-none max-w-none overflow-visible bg-transparent p-0 backdrop:bg-black/90"
      data-testid="media-lightbox"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      ref={dialogRef}
    >
      <div className="relative">
        {media.type === "video" ? (
          <video
            aria-label={media.alt}
            className="block max-h-[90dvh] max-w-[calc(100vw-32px)] rounded-[10px] bg-black"
            controls
            data-testid="media-lightbox-video"
            playsInline
            src={media.url}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- private originals of unknown size, shown at natural aspect
          <img
            alt={media.alt}
            className="block max-h-[90dvh] max-w-[calc(100vw-32px)] rounded-[10px] object-contain"
            data-testid="media-lightbox-image"
            src={media.url}
          />
        )}
        <button
          aria-label="Close"
          className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white"
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </dialog>
  );
}
