"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveViewerAuthority } from "./viewer-auth";

const DISMISS_KEY = "od-upgrade-toast-dismissed";

export function PromoToast() {
  // 默认隐藏，挂载后再决定：localStorage 仅浏览器可用，避免 SSR/hydration 闪烁。
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // localStorage 仅浏览器可用，挂载后再决定可见性；用 setTimeout(0) 推迟到
    // effect 体外，避免同步 setState 触发级联渲染。
    const timer = window.setTimeout(() => {
      let dismissed = false;
      try {
        dismissed = localStorage.getItem(DISMISS_KEY) === "true";
      } catch {
        // localStorage 不可用时按未关闭处理。
      }
      if (dismissed) return;
      // SPEC: 已经在付费档上的人不该再被这张卡挡住角色。
      // INTENT: 这张卡是浮在内容之上的，过去只看 localStorage 有没有关过 ——
      //   于是最高档订阅者一边付着钱，一边被一张「Compare the current plans」
      //   压住角色卡。拿不到身份时保持隐藏：宁可少展示，也不要推销给已经买了的人。
      void resolveViewerAuthority()
        .then((viewer) => {
          if (!cancelled && !viewer.entitlements?.plan) setVisible(true);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // localStorage 不可用时仅当前会话隐藏即可。
    }
  }

  if (!visible) return null;

  return (
    <aside className="fixed bottom-6 right-6 z-30 hidden w-[300px] rounded-[20px] bg-[rgb(46,46,46)] p-3 shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)] lg:block">
      <div className="relative h-[178px] overflow-hidden rounded-[14px]">
        <Image
          src="/images/ourdream/promo-card-female.webp"
          alt=""
          fill
          loading="eager"
          sizes="276px"
          className="object-cover"
          unoptimized
        />
        <button
          aria-label="Close promotion"
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-black/35 text-white"
          onClick={dismiss}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="px-1 pb-1 pt-3">
        <h2 className="text-[16px] font-black uppercase italic leading-4 text-white">
          Upgrade options
        </h2>
        <p className="mt-1 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]">
          Compare the current plans, included Dreamcoins, and generation access.
        </p>
        <Link
          className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-full bg-white text-[12px] font-bold leading-4 text-[rgb(13,13,13)]"
          href="/upgrade"
        >
          View plans
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </aside>
  );
}
