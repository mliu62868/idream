"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicExposureContext } from "@/lib/public-api-contracts";

const CHARACTER_EXPOSURE_EVENT = "character.exposure.recorded.v2";
const ELIGIBLE_VISIBLE_RATIO = 0.5;
const ELIGIBLE_VISIBLE_MS = 500;

type ExposureContext = PublicExposureContext | null | undefined;

// SPEC: 服务端的曝光 id 在 journey + Character + placement 内确定，所以它就是去重键。
// INTENT: 放在模块级才能跨卡片重新挂载和列表重新拉取；刷新页面后清空也无妨，
// 服务端按同一 id 幂等。
const recordedExposureIds = new Set<string>();

function sendExposure(
  characterId: string,
  context: PublicExposureContext,
  event: {
    eventType: "eligible_impression" | "detail_view";
    exposureId: string;
    parentExposureId: string | null;
    visibleDurationMs: number;
    visibleRatio: number;
  },
) {
  const payload = JSON.stringify({
    name: CHARACTER_EXPOSURE_EVENT,
    props: {
      contextToken: context.contextToken,
      characterId,
      journeyId: context.journeyId,
      placementId: context.placementId,
      ...event,
    },
  });
  if (typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon("/api/v1/events/track", new Blob([payload], { type: "application/json" }));
    return;
  }
  void fetch("/api/v1/events/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

export function characterEntryAttribution(context: ExposureContext): Record<string, string> {
  return context
    ? { entryExposureId: context.detailExposureId, journeyId: context.journeyId, placementId: context.placementId }
    : {};
}

export function characterEntryHref(characterId: string, context: ExposureContext) {
  const path = `/characters/${encodeURIComponent(characterId)}`;
  return context ? `${path}?${new URLSearchParams(characterEntryAttribution(context))}` : path;
}

// INVARIANT: detail_view 的父节点必须是已上报的曝光，否则投影器会判断链路无效。
export function recordCharacterDetailView(characterId: string, context: ExposureContext) {
  if (
    !context ||
    !recordedExposureIds.has(context.impressionExposureId) ||
    recordedExposureIds.has(context.detailExposureId)
  ) return;
  recordedExposureIds.add(context.detailExposureId);
  sendExposure(characterId, context, {
    eventType: "detail_view",
    exposureId: context.detailExposureId,
    parentExposureId: context.impressionExposureId,
    visibleDurationMs: 0,
    visibleRatio: 1,
  });
}

// SPEC: 主站所有角色发现卡片共用的曝光跟踪：至少 50% 可见并持续 500ms 记一次曝光。
// 进详情或开聊的后续链路由 href / recordDetailView 接上。没有上下文时什么都不做。
export function useCharacterExposure<T extends Element>(
  characterId: string,
  context: ExposureContext,
  onEligibleImpression?: () => void,
) {
  const [node, setNode] = useState<T | null>(null);
  const exposureContext = context ?? null;

  useEffect(() => {
    if (!node || !exposureContext || typeof IntersectionObserver === "undefined") return;
    if (!onEligibleImpression && recordedExposureIds.has(exposureContext.impressionExposureId)) return;
    let timer: number | null = null;
    let visibleRatio = 0;
    const clearEligibilityTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRatio = entry.intersectionRatio;
        if (!entry.isIntersecting || visibleRatio < ELIGIBLE_VISIBLE_RATIO) {
          clearEligibilityTimer();
          return;
        }
        if (timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          observer.disconnect();
          onEligibleImpression?.();
          if (recordedExposureIds.has(exposureContext.impressionExposureId)) return;
          recordedExposureIds.add(exposureContext.impressionExposureId);
          sendExposure(characterId, exposureContext, {
            eventType: "eligible_impression",
            exposureId: exposureContext.impressionExposureId,
            parentExposureId: null,
            visibleDurationMs: ELIGIBLE_VISIBLE_MS,
            visibleRatio,
          });
        }, ELIGIBLE_VISIBLE_MS);
      },
      { threshold: [0, ELIGIBLE_VISIBLE_RATIO, 1] },
    );
    observer.observe(node);
    return () => {
      clearEligibilityTimer();
      observer.disconnect();
    };
  }, [characterId, exposureContext, node, onEligibleImpression]);

  const recordDetailView = useCallback(
    () => recordCharacterDetailView(characterId, exposureContext),
    [characterId, exposureContext],
  );

  return { attach: setNode, entryHref: characterEntryHref(characterId, exposureContext), recordDetailView };
}
