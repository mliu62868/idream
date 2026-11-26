"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { voiceClipQuoteSchema, type VoiceClipQuote } from "@idream/shared/contracts";
import type { RuntimeChatMessage as ChatMessage } from "@/lib/public-api-contracts";
import { chatFailureCopy } from "@/lib/chat-failure-copy";

type VoiceClipRequestResult = {
  url: string | null;
  quote?: VoiceClipQuote;
  errorMessage?: string;
  reason:
    | "allowance_exhausted"
    | "disabled"
    | "failed"
    | "insufficient_balance"
    | "confirmation_required"
    | null;
};

export type VoiceConfirmation = { messageId: string; text: string; quote: VoiceClipQuote };

type ReceiptContext = { isCurrent: () => boolean; persistence: { ownerScope: string } };

type VoicePlaybackOptions = {
  readonly fetchForSession: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly receiptContext: () => ReceiptContext;
  readonly messages: readonly ChatMessage[];
  readonly executionSessionId: string;
  readonly characterId: string | null;
  /** Dictation owns the microphone and the speaker until it finishes. */
  readonly isRecording: () => boolean;
  readonly onStatus: (status: string | null) => void;
  readonly onInsufficientBalance: () => void;
  readonly onPlaybackStart: () => void;
};

// SPEC: Voice synthesis starts only after the reader presses Play. Repeated
//       plays of the same selected reply reuse its clip.
// INVARIANT: a regenerated Turn keeps its message id but changes its text and
//            attempt. Its audio must never come from the discarded reply.
export function useVoicePlayback(options: VoicePlaybackOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const [preparingIds, setPreparingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<VoiceConfirmation | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const intentRef = useRef(0);
  const playbackMessageIdRef = useRef<string | null>(null);
  const requestsRef = useRef<Map<string, { key: string; promise: Promise<VoiceClipRequestResult> }>>(new Map());
  const urlsRef = useRef<Map<string, { key: string; url: string }>>(new Map());
  const playingIdRef = useRef<string | null>(null);
  useLayoutEffect(() => { playingIdRef.current = playingId; }, [playingId]);

  useLayoutEffect(() => () => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.src = "";
    audioRef.current = null;
    intentRef.current += 1;
  }, []);

  function stop() {
    intentRef.current += 1;
    playbackMessageIdRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    audioRef.current = null;
    setPlayingId(null);
    setConfirmation(null);
  }

  /** Forget every clip and request; used when the conversation or its owner changes. */
  function reset() {
    stop();
    requestsRef.current.clear();
    urlsRef.current.clear();
    setPreparingIds(new Set());
  }

  function invalidate(messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      if (playbackMessageIdRef.current === messageId) stop();
      requestsRef.current.delete(messageId);
      urlsRef.current.delete(messageId);
    }
    setPreparingIds(current => new Set([...current].filter(id => !messageIds.includes(id))));
  }

  async function requestClip(
    messageId: string,
    text: string,
    acceptedQuoteToken?: string,
  ): Promise<VoiceClipRequestResult> {
    const { fetchForSession, messages, executionSessionId, characterId } = latest.current;
    const receiptContext = latest.current.receiptContext();
    const playbackIntent = intentRef.current;
    const message = messages.find((item) => item.id === messageId);
    const sourceSessionId = message?.sessionId ?? executionSessionId;
    const sourceCharacterId = message?.characterId ?? characterId;
    const key = JSON.stringify([sourceSessionId, message?.attempt, text]);
    const cachedClip = urlsRef.current.get(messageId);
    if (cachedClip?.key === key) return { url: cachedClip.url, reason: null };
    const existingRequest = requestsRef.current.get(messageId);
    if (existingRequest?.key === key) return existingRequest.promise;

    setPreparingIds((current) => new Set(current).add(messageId));
    const request = (async (): Promise<VoiceClipRequestResult> => {
      try {
        const body = { characterId: sourceCharacterId, messageId, sessionId: sourceSessionId, intent: "play" };
        const headers = { "content-type": "application/json", "x-idream-viewer-scope": receiptContext.persistence.ownerScope };
        if (!acceptedQuoteToken) {
          const quoted = await fetchForSession("/api/v1/generation/voice/quote", {
            method: "POST", headers, cache: "no-store", body: JSON.stringify(body),
          });
          const payload = await quoted.json().catch(() => null);
          if (!receiptContext.isCurrent() || playbackIntent !== intentRef.current) return { url: null, reason: "failed" };
          if (quoted.status === 402) return { url: null, reason: "insufficient_balance" };
          if (!quoted.ok) return { url: null, reason: "failed", errorMessage: chatFailureCopy(payload, "Voice price could not load. Press Play to check again.") };
          const quote = voiceClipQuoteSchema.parse(payload?.data?.quote);
          if (!quote.accepted && !quote.alreadyDelivered) {
            if (!quote.quoteToken) return { url: null, reason: "failed", errorMessage: "Voice price could not be confirmed. Press Play to check again." };
            return { url: null, reason: "confirmation_required", quote };
          }
          acceptedQuoteToken = quote.quoteToken ?? undefined;
        }
        // Stopping playback or starting dictation revokes permission to spend
        // on a quote that completed after the reader changed their intent.
        if (!receiptContext.isCurrent() || playbackIntent !== intentRef.current) return { url: null, reason: "failed" };
        const response = await fetchForSession("/api/v1/generation/voice", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, quoteToken: acceptedQuoteToken }),
        });
        if (response.status === 402) return { url: null, reason: "insufficient_balance" };
        if (!response.ok) return { url: null, reason: "failed", errorMessage: chatFailureCopy(await response.json().catch(() => null), "Voice playback could not be confirmed. Press Play to check the original request.") };
        const payload = (await response.json()) as {
          data?: {
            contentUrl?: string;
            reason?: "allowance_exhausted" | "disabled";
          };
        };
        if (!receiptContext.isCurrent()) return { url: null, reason: "failed" };
        const url = payload.data?.contentUrl;
        if (url) {
          if (requestsRef.current.get(messageId)?.key === key) {
            urlsRef.current.set(messageId, { key, url });
          }
          return { url, reason: null };
        }
        return {
          url: null,
          reason: payload.data?.reason ?? "failed",
        };
      } catch {
        return { url: null, reason: "failed" };
      }
    })().finally(() => {
      if (requestsRef.current.get(messageId)?.key !== key) return;
      requestsRef.current.delete(messageId);
      setPreparingIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    });
    requestsRef.current.set(messageId, { key, promise: request });
    return request;
  }

  async function play(messageId: string, text: string, acceptedQuoteToken?: string) {
    const { onStatus } = latest.current;
    if (latest.current.isRecording()) {
      onStatus("Finish recording before playing voice.");
      return;
    }
    if (!latest.current.characterId || !text.trim()) return;
    if (playingIdRef.current === messageId) {
      stop();
      return;
    }
    stop();
    playbackMessageIdRef.current = messageId;
    const playbackIntent = intentRef.current;
    latest.current.onPlaybackStart();
    try {
      const result = await requestClip(messageId, text, acceptedQuoteToken);
      if (playbackIntent !== intentRef.current) return;
      if (result.reason === "confirmation_required" && result.quote) {
        setConfirmation({ messageId, text, quote: result.quote });
        return;
      }
      if (result.reason === "insufficient_balance") {
        latest.current.onInsufficientBalance();
        latest.current.onStatus("Voice playback needs more dreamcoins.");
        return;
      }
      if (!result.url) {
        latest.current.onStatus(result.errorMessage ?? "Voice playback failed. Please try again.");
        return;
      }
      const clipKey = urlsRef.current.get(messageId)?.key;
      const audio = new Audio(result.url);
      audioRef.current = audio;
      audio.onended = () => {
        if (playbackIntent !== intentRef.current) return;
        setPlayingId((current) => (current === messageId ? null : current));
      };
      audio.onerror = () => {
        if (playbackIntent !== intentRef.current) return;
        const cached = urlsRef.current.get(messageId);
        // A deleted/unreadable clip must be revalidated on the next explicit
        // Play. An old player's error must never evict a replacement clip.
        if (cached?.key === clipKey && cached?.url === result.url) {
          urlsRef.current.delete(messageId);
        }
        latest.current.onStatus("Voice playback failed. Please try again.");
        setPlayingId((current) => (current === messageId ? null : current));
      };
      await audio.play();
      if (playbackIntent !== intentRef.current) return;
      setPlayingId(messageId);
    } catch {
      if (playbackIntent !== intentRef.current) return;
      latest.current.onStatus("Voice playback failed. Please try again.");
    }
  }

  return {
    preparingIds,
    playingId,
    confirmation,
    dismissConfirmation: () => setConfirmation(null),
    play,
    stop,
    reset,
    invalidate,
  };
}
