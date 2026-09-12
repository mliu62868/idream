"use client";

import { useCallback, useEffect, useState } from "react";
import {
  parseGenerationContextResponse,
  type RuntimeGenerationContext,
} from "@/lib/public-api-contracts";

const chatFields = ["chatSessionId", "chatTurnId", "chatAttempt", "chatMediaAssetId"] as const;
const comicFields = ["comicId", "comicVersion", "comicPageId"] as const;
const routeFields = [...chatFields, ...comicFields];
type Route = { kind: "none" } | { kind: "invalid" } | { kind: "source"; query: string };

export function generationContextRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const chat = chatFields.some(field => params.has(field));
  const comic = comicFields.some(field => params.has(field));
  if (!chat && !comic) return { kind: "none" };
  if ((chat && comic) || routeFields.some(field => params.getAll(field).length > 1)) return { kind: "invalid" };
  const validId = (value: string | null) => Boolean(value && value.length <= 160);
  const validVersion = (value: string | null) => Boolean(value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
  if (comic) {
    const comicId = params.get("comicId"), comicVersion = params.get("comicVersion"), pageId = params.get("comicPageId");
    if (!validId(comicId) || !validVersion(comicVersion) || !validId(pageId)) return { kind: "invalid" };
    return { kind: "source", query: new URLSearchParams({ kind: "comic", comicId: comicId!, comicVersion: comicVersion!, pageId: pageId! }).toString() };
  }
  const sessionId = params.get("chatSessionId"), turnId = params.get("chatTurnId"), attempt = params.get("chatAttempt"), mediaAssetId = params.get("chatMediaAssetId");
  if (!validId(sessionId) || !validId(turnId) || !validVersion(attempt) || (mediaAssetId !== null && !validId(mediaAssetId))) return { kind: "invalid" };
  const query = new URLSearchParams({ kind: "chat", sessionId: sessionId!, turnId: turnId!, attempt: attempt! });
  if (mediaAssetId) query.set("mediaAssetId", mediaAssetId);
  return { kind: "source", query: query.toString() };
}

type Snapshot = { scope: string; query: string; data: RuntimeGenerationContext | null; error: string };

/** Resolves generation context only under the currently confirmed viewer. */
export function useGenerationContext(viewerScope: string | null) {
  const [route, setRoute] = useState<Route | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retry = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    const readRoute = () => setRoute(generationContextRoute(window.location.search));
    readRoute();
    window.addEventListener("popstate", readRoute);
    return () => window.removeEventListener("popstate", readRoute);
  }, []);
  const query = route?.kind === "source" ? route.query : null;
  useEffect(() => {
    if (!viewerScope || !query) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/generation/context?${query}`, {
          cache: "no-store",
          headers: { "x-idream-viewer-scope": viewerScope },
          signal: controller.signal,
        });
        const raw: unknown = await response.json();
        if (!response.ok) throw new Error("This source is no longer available. Return to it and open Generate again.");
        const data = parseGenerationContextResponse(raw);
        if (!controller.signal.aborted) setSnapshot({ scope: viewerScope, query, data, error: "" });
      } catch {
        if (!controller.signal.aborted) setSnapshot({
          scope: viewerScope, query, data: null,
          error: "The original generation context could not be loaded. Retry, or reopen the current source.",
        });
      }
    })();
    return () => controller.abort();
  }, [query, refresh, viewerScope]);
  const clear = useCallback(() => {
    const url = new URL(window.location.href);
    for (const field of routeFields) url.searchParams.delete(field);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setRoute({ kind: "none" });
    setSnapshot(null);
  }, []);
  const current = viewerScope && snapshot?.scope === viewerScope && snapshot.query === query ? snapshot : null;
  const required = route !== null && route.kind !== "none";
  return {
    initialized: route !== null,
    required,
    data: required ? current?.data ?? null : null,
    error: route?.kind === "invalid" ? "This generation link is incomplete. Return to its source and open Generate again." : current?.error ?? "",
    clear,
    retry,
  };
}
