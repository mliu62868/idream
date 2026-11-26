"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  Loader2,
  MessageCircle,
  Video,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  parseChatSendResponse,
  parseChatSessionCreateResponse,
  type RuntimeChatMessage as ChatMessage,
  type RuntimeChatSession as ChatSession,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { useGenerationReceipts } from "@/hooks/useGenerationReceipts";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useVoiceCall } from "@/hooks/useVoiceCall";
import { VoiceInputButton, VoiceInputStatus } from "./chat/VoiceInputControls";
import { VoiceCallButton, VoiceCallControls } from "./chat/VoiceCallControls";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { ChatHeaderControls } from "./chat/ChatHeaderControls";
import { ChatSessionListDrawer } from "./chat/ChatSessionListDrawer";
import { MemoryPanel } from "./chat/MemoryPanel";
import { ConversationPreferences } from "./chat/ConversationPreferences";
import { authHrefForTarget } from "./authRedirect";
import { useReportDialog } from "./ReportDialog";
import { chatFailureCopy } from "@/lib/chat-failure-copy";
import { chatReleaseChangedCharacterId, stashChatReleaseHandoff, takeChatReleaseHandoff } from "@/lib/chat-release-handoff";
import { chatGenerationHref } from "@/lib/chat-generation-link";
import { chatVideoSources, isExplicitChatVideoRequest } from "@/lib/chat-video";
import { ChatVideoComposer } from "./chat/ChatVideoComposer";
import {
  chatStreamMessagesNeedReconciliation,
  useChatReplyDelivery,
} from "./chat-reply-delivery";
import {
  canSubmitChatMessage,
  latestTurnUserMessageId,
  LOCAL_CHAT_MESSAGE_ID_PREFIX,
  prepareChatSendIntent,
  type ChatSendIntent,
} from "./chat-message-actions";
import type { GenerationQuoteAuthority } from "@/lib/generation-write-client";
import { GroupSpeakerControls, mentionedGroupCharacter } from "./chat/GroupSpeakerControls";
import { useViewerGate, type ViewerGate } from "@/hooks/useViewerGate";
import { chatAttachmentIsActive, chatAttachmentIsUnconfirmed } from "./chat/chat-attachments";
import {
  chatSessionIsReadOnly,
  chatSessionMetadataReducer,
  INITIAL_CHAT_SESSION_METADATA,
} from "./chat/chat-session-metadata";
import { useVoicePlayback } from "./chat/useVoicePlayback";
import { useChatMediaActions } from "./chat/useChatMediaActions";
import { isChatAuthError, useChatSessionSync, type ChatLoadState } from "./chat/useChatSessionSync";
import { ChatMessageList, type ChatEditingTarget } from "./chat/ChatMessageList";
import type { ChatAttachmentContext, ChatMessageHandlers } from "./chat/ChatMessageItem";
import { ChatComposer } from "./chat/ChatComposer";
import { useStableHandlers } from "./chat/useStableHandlers";

export { chatAttachmentCostLabel, chatAttachmentIsActive } from "./chat/chat-attachments";

type ChatUpgradeReason = "dreamcoins" | "messages";

const SPEAKER_SELECT_FAILED = "Couldn't select that Character. Try again.";
const CHAT_RELEASE_HANDOFF_NOTICE =
  "This Character was updated, so we opened a new chat. Your unsent message is ready below. The earlier conversation stays in your chats.";
// A reply is only auto-followed while the reader is parked within this many
// pixels of the bottom; above that the viewport belongs to the reader.
const STICK_TO_BOTTOM_SLACK_PX = 120;

export function chatUpgradeLinkLabel(reason: ChatUpgradeReason) {
  if (reason === "dreamcoins") return "Get more dreamcoins";
  return "Upgrade for unlimited messages";
}

function upgradeHrefForChatSession(sessionId: string, groupMode = false) {
  return `/upgrade?returnTo=${encodeURIComponent(`/chat/${groupMode ? "groups/" : ""}${encodeURIComponent(sessionId)}`)}`;
}

// SPEC: Follow the newest message only while the reader is parked at it: the end
//       of the message list sits at most the slack below the top of the sticky
//       composer dock (what is under the dock is not visible).
//       Only the reader scrolling up releases the pin.
// INTENT: a stream re-renders on every token; without this the reader is dragged
//         back down and can never scroll up through the history mid-reply.
//         A smooth jump-to-latest is still travelling when the next message
//         lands, so its own scroll events must not count as the reader leaving.
export function chatViewPinAfterScroll(input: {
  readonly wasPinned: boolean;
  readonly previousScrollY: number;
  readonly scrollY: number;
  readonly latestBelowViewportPx: number;
}): boolean {
  if (input.latestBelowViewportPx <= STICK_TO_BOTTOM_SLACK_PX) return true;
  return input.wasPinned && input.scrollY >= input.previousScrollY;
}

// The composer dock sits in flow right after the message list, so at the page
// end the latest message is fully above it regardless of the dock's height.
function scrollChatToEnd(behavior: ScrollBehavior) {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

// SPEC: Everything the page derives from the message list, computed in one pass
//       per change instead of one scan (or copy) per question per render.
export function chatMessagesSummary(messages: readonly ChatMessage[], options: { groupCharacterId?: string | null } = {}) {
  let hasActiveAttachment = false;
  let hasUnconfirmedAttachment = false;
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (chatAttachmentIsActive(attachment.status, attachment.errorCode)) hasActiveAttachment = true;
      if (chatAttachmentIsUnconfirmed(attachment.status, attachment.errorCode)) hasUnconfirmedAttachment = true;
    }
  }
  let latestUserIndex = -1;
  let latestCompletedReply: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (latestUserIndex < 0 && message.role === "user") latestUserIndex = index;
    if (!latestCompletedReply && message.role === "assistant" && message.status === "sent" && message.turnId
      && (options.groupCharacterId === undefined || message.characterId === options.groupCharacterId)) {
      latestCompletedReply = message;
    }
    if (latestUserIndex >= 0 && latestCompletedReply) break;
  }
  let latestReplyInProgress = false;
  if (latestUserIndex >= 0) {
    for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role === "assistant" && (message.status === "generating" || message.status === "pending")) {
        latestReplyInProgress = true;
        break;
      }
    }
  }
  return {
    hasActiveAttachment,
    hasUnconfirmedAttachment,
    hasGeneratingReply: chatStreamMessagesNeedReconciliation(messages),
    latestUserMessageId: latestTurnUserMessageId(messages),
    latestReplyInProgress,
    latestCompletedReply,
  };
}

export function ChatSessionClient({ id, groupMode = false }: Readonly<{ id: string; groupMode?: boolean }>) {
  const viewer = useViewerGate({ require: "any" });
  // A confirmed owner change revokes the whole private conversation, including
  // drawers, drafts, playback and pending receipts. Same-owner revalidation
  // keeps this subtree and its readable history through a network blip.
  return <ChatSessionContent id={id} groupMode={groupMode} viewer={viewer}
    key={`${groupMode ? "group" : "single"}:${id}:${viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")}`} />;
}

function ChatSessionContent({ id, groupMode, viewer }: Readonly<{ id: string; groupMode: boolean; viewer: ViewerGate }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const mountedRef = useRef(true);
  const gatedFetch = viewer.fetch;
  const fetchForSession = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!mountedRef.current) throw new DOMException("Conversation owner changed", "AbortError");
    const response = await gatedFetch(input, init);
    if (!mountedRef.current) throw new DOMException("Conversation owner changed", "AbortError");
    return response;
  }, [gatedFetch]);
  const [metadata, dispatchMetadata] = useReducer(chatSessionMetadataReducer, INITIAL_CHAT_SESSION_METADATA);
  const { title, characterId, group, canUpdateIdentity, characterImage, memberImages, memoryEnabled, proactiveEnabled, continuation } = metadata;
  const conversationArchived = metadata.archived;
  const conversationReadOnly = chatSessionIsReadOnly(metadata);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadState, setLoadState] = useState<ChatLoadState>("loading");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { openReport, reportDialog } = useReportDialog(setStatus);
  const [upgradeReason, setUpgradeReason] = useState<ChatUpgradeReason | null>(null);
  const [speakerPending, setSpeakerPending] = useState(false);
  const [sendOutcomeUnknown, setSendOutcomeUnknown] = useState(false);
  const selectedSpeakerRef = useRef<string | null>(null);
  const executionSessionId = group?.selectedSessionId ?? id;
  const sessionPath = `/api/v1/chat/${groupMode ? "groups" : "sessions"}/${encodeURIComponent(id)}`;
  // SPEC: 只在这段会话真的能出视频时才给 Video / Animate 入口。
  // INTENT: 后端 GET /api/v1/chat/:id/video 早就返回 capability，前台却一处都没读，
  //   于是 chat_video 关着时按钮照样在、点开才看到「currently unavailable」；群聊更糟，
  //   群 id 在 recentChat 里查不到，点下去必定 404。enabled=false 是用户无解的死路，
  //   直接不给入口；entitled=false 用户能自己升级，保留入口走付费墙。
  const [videoCapability, setVideoCapability] = useState<{ sessionId: string; enabled: boolean } | null>(null);
  const videoEnabled = ageGateAccepted && !conversationReadOnly && !groupMode && videoCapability?.sessionId === id && videoCapability.enabled;
  const [memoryPending, setMemoryPending] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<ChatEditingTarget | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingPending, setEditingPending] = useState(false);
  const editIntentRef = useRef<{ content: string; allowPaidImage: boolean; idempotencyKey: string } | null>(null);
  const [deleteConfirmMessageId, setDeleteConfirmMessageId] = useState<string | null>(null);
  const [receiptOwnerScope, setReceiptOwnerScope] = useState<string | null>(null);
  // The focus re-check clears the scope while it asks; this keeps the last one
  // so a network blip can hand it back instead of hiding pending receipts.
  const receiptOwnerScopeRef = useRef<string | null>(null);
  useEffect(() => { if (receiptOwnerScope) receiptOwnerScopeRef.current = receiptOwnerScope; }, [receiptOwnerScope]);
  const [receiptWarning, setReceiptWarning] = useState("");
  const {
    receipts: generationReceipts,
    checkingKeys: checkingReceiptKeys,
    context: generationReceiptContext,
    refresh: refreshGenerationReceipts,
    recover: recoverGenerationReceipt,
    suspend: suspendGenerationReceipts,
    resume: resumeGenerationReceipts,
  } = useGenerationReceipts({ ownerScope: receiptOwnerScope, onWarning: setReceiptWarning });
  const [jumpToLatestVisible, setJumpToLatestVisible] = useState(false);
  const pinnedToBottomRef = useRef(true);
  const sendIntentRef = useRef<ChatSendIntent | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const summary = useMemo(
    () => chatMessagesSummary(messages, { groupCharacterId: group ? characterId : undefined }),
    [messages, group, characterId],
  );
  const { hasActiveAttachment, hasUnconfirmedAttachment, hasGeneratingReply } = summary;
  const voiceInputReadOnlyRef = useRef(false);
  const voice = useVoicePlayback({
    fetchForSession,
    receiptContext: generationReceiptContext,
    messages,
    executionSessionId,
    characterId,
    isRecording: () => voiceInputReadOnlyRef.current,
    onStatus: setStatus,
    onInsufficientBalance: () => setUpgradeReason("dreamcoins"),
    onPlaybackStart: () => { setStatus(null); setUpgradeReason(null); },
  });
  const stopVoice = voice.stop;
  const voiceInput = useVoiceInput({
    sessionPath,
    ownerScope: receiptOwnerScope,
    enabled: ageGateAccepted && loadState === "ready" && !conversationReadOnly,
    recipientId: groupMode ? characterId : null,
    draft: content,
    onDraft: (text) => {
      setContent(text);
      if (window.matchMedia?.("(pointer: fine)").matches) {
        window.requestAnimationFrame(() => {
          composerRef.current?.focus({ preventScroll: true });
          composerRef.current?.setSelectionRange(text.length, text.length);
        });
      }
    },
    beforeRecording: () => stopVoice(),
  });
  useLayoutEffect(() => { voiceInputReadOnlyRef.current = voiceInput.readOnly; });
  const delivery = useChatReplyDelivery({
    conversationId: id,
    messages,
    setMessages,
    readSession: (signal) => sync.fetchSession(signal),
    request: fetchForSession,
    onSession: applySessionMetadata,
    onSessionReadError: revokeUnavailableSession,
    onRepliesInvalidated: (messageIds) => voice.invalidate(messageIds),
    onStatus: setStatus,
  });
  const stoppingReply = delivery.stopping;
  const voiceCall = useVoiceCall({
    sessionPath, ownerScope: receiptOwnerScope,
    enabled: ageGateAccepted && loadState === "ready" && !conversationReadOnly && !groupMode,
    beforeConnect: () => { stopVoice(); voiceInput.cancel(); },
    onTurn: (turn) => delivery.receiveTurn(turn),
  });
  const media = useChatMediaActions({
    conversationId: id,
    characterId,
    receiptOwnerScope,
    delivery,
    fetchForSession,
    receiptContext: generationReceiptContext,
    refreshReceipts: refreshGenerationReceipts,
    recoverReceipt: recoverGenerationReceipt,
    setMessages,
    onStatus: setStatus,
    onInsufficientBalance: () => setUpgradeReason("dreamcoins"),
    onClearDeleteConfirm: () => setDeleteConfirmMessageId(null),
    onVideoRequested: () => setContent(""),
  });
  const sync = useChatSessionSync({
    id,
    groupMode,
    sessionPath,
    viewer,
    ageGateAccepted,
    delivery,
    fetchForSession,
    selectedSpeakerRef,
    receiptOwnerScopeRef,
    setLoadState,
    onStatus: setStatus,
    onReset: resetConversation,
    onLoaded: () => {
      const handedOver = groupMode ? null : takeChatReleaseHandoff(id);
      if (handedOver !== null) {
        setContent((current) => current || handedOver);
        setStatus(CHAT_RELEASE_HANDOFF_NOTICE);
      }
    },
    suspendReceipts: suspendGenerationReceipts,
    resumeReceipts: resumeGenerationReceipts,
    setReceiptOwnerScope,
    reconciliation: {
      hasActiveAttachment,
      hasUnconfirmedAttachment,
      hasGeneratingReply,
      proactiveEnabled,
      writing: pending || editingPending || memoryPending,
    },
  });
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      suspendGenerationReceipts(true);
    };
  }, [suspendGenerationReceipts]);
  const canSend = canSubmitChatMessage(
    content,
    pending || stoppingReply || speakerPending || conversationReadOnly || voiceInput.blocksSend || voiceCall.active,
    hasGeneratingReply,
  );

  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(128, Math.max(48, input.scrollHeight))}px`;
  }, [content, loadState]);

  useEffect(() => {
    let previousScrollY = window.scrollY;
    const onScroll = () => {
      const latestEnd = messagesEndRef.current?.getBoundingClientRect().bottom;
      // The sticky composer dock covers the bottom of the viewport, so "visible"
      // ends at its top edge, not at the viewport edge.
      const visibleBottom = composerDockRef.current?.getBoundingClientRect().top ?? window.innerHeight;
      pinnedToBottomRef.current = chatViewPinAfterScroll({
        wasPinned: pinnedToBottomRef.current,
        previousScrollY,
        scrollY: window.scrollY,
        latestBelowViewportPx: latestEnd === undefined ? 0 : latestEnd - visibleBottom,
      });
      previousScrollY = window.scrollY;
      if (pinnedToBottomRef.current) setJumpToLatestVisible(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // SPEC: Keep the newest message (and its streaming deltas) in view whenever the
  //       message list or the sticky composer dock changes size — new messages,
  //       tokens, images, and dock blocks that mount late (voice controls) alike.
  // INTENT: following on `messages` alone ran before late dock blocks mounted, so on
  //         entry the dock grew over the latest reply (audit P1-1). The follow target
  //         is the page end: there the dock sits in flow right below the list, so the
  //         latest message clears it whatever the dock's height — no scroll-margin guess.
  //         Header blocks above the list are not observed: opening Conversation
  //         preferences must not yank its reader down to the composer.
  //         Jumps are instant; per-token smooth animations restart each other.
  useEffect(() => {
    const list = messageListRef.current;
    const dock = composerDockRef.current;
    if (!list || !dock || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) scrollChatToEnd("auto");
    });
    observer.observe(list);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [loadState]);

  // A reader who scrolled up keeps their place and gets a jump control instead.
  useEffect(() => {
    if (!pinnedToBottomRef.current) setJumpToLatestVisible(true);
  }, [messages]);

  function resetConversation() {
    pinnedToBottomRef.current = true;
    setJumpToLatestVisible(false);
    setVoiceCallOpen(false);
    voice.reset();
    setReceiptOwnerScope(null);
    suspendGenerationReceipts(true);
    setReceiptWarning("");
    media.reset();
    dispatchMetadata({ type: "reset" });
    setMessages([]);
    setStatus(null);
    selectedSpeakerRef.current = null;
    setSendOutcomeUnknown(false);
  }

  useEffect(() => {
    if (groupMode || !ageGateAccepted || viewer.identity?.kind !== "user") return;
    const controller = new AbortController();
    void fetchForSession(`/api/v1/chat/${encodeURIComponent(id)}/video`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? await response.json() : null))
      .then((payload: unknown) => {
        if (controller.signal.aborted) return;
        const enabled = (payload as { data?: { capability?: { enabled?: unknown } } })?.data
          ?.capability?.enabled;
        setVideoCapability({ sessionId: id, enabled: enabled === true });
      })
      .catch(() => {
        // 读不到 capability 时不假装可用，也不吞掉历史视频——只是不给新入口。
        if (!controller.signal.aborted) setVideoCapability({ sessionId: id, enabled: false });
      });
    return () => controller.abort();
  }, [ageGateAccepted, groupMode, id, viewer.identity, fetchForSession]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (voiceInput.blocksSend || voiceCall.active) return;
    const text = content.trim();
    const allowPaidImage = (event.nativeEvent as SubmitEvent).submitter?.dataset.paidImage === "true";
    // SPEC: 输入 @Name 时说话人切换是异步的；切换期间的回车必须有回执。
    // INTENT: 静默 return 会让用户以为消息发出去了 —— 实测第一次回车既不发消息也不报错。
    if (text && speakerPending) {
      setStatus("Selecting that Character… send again once the recipient is ready.");
      return;
    }
    if (!canSubmitChatMessage(text, pending || speakerPending || conversationReadOnly, hasGeneratingReply)) return;
    const mentioned = group ? mentionedGroupCharacter(text, group.members) : null;
    if (mentioned && mentioned !== characterId) {
      await changeSpeaker(mentioned);
      setStatus("Speaker selected. Review the recipient, then send your message.");
      return;
    }
    const mentionedName = group?.members.find(member => member.characterId === mentioned)?.name;
    const videoText = mentionedName ? text.slice(mentionedName.length + 1).replace(/^[,:]\s*/, "").trim() : text;
    // With video unavailable here the words are just roleplay and go to the character.
    if (!allowPaidImage && videoEnabled && isExplicitChatVideoRequest(videoText) && receiptOwnerScope) {
      media.openVideoRequest(undefined, videoText);
      return;
    }
    const prepared = prepareChatSendIntent(sendIntentRef.current, { sessionId: id, content: text, characterId, allowPaidImage }, sendOutcomeUnknown);
    if (prepared.kind !== "ready") {
      if (prepared.kind === "protocol_expired") {
        sendIntentRef.current = null;
        setSendOutcomeUnknown(false);
      }
      setStatus(prepared.kind === "protocol_expired"
        ? "This send request expired. Review your draft and send it again."
        : "The last message is unconfirmed. Use the same send option to check it.");
      return;
    }
    const intent = prepared.intent;
    setStatus(null);
    setUpgradeReason(null);
    setContent("");
    setPending(true);
    const sendDelivery = delivery.context({ invalidate: true });
    // SPEC: Render the reader's own turn before the round-trip resolves — on a
    //       phone the POST costs a full reply latency, and an input that empties
    //       into nothing reads as a dropped message.
    const localMessageId = `${LOCAL_CHAT_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
    const dropOptimisticMessage = (current: ChatMessage[]) =>
      current.filter((message) => message.id !== localMessageId);
    setMessages((current) => [
      ...current,
      { id: localMessageId, role: "user", content: text },
    ]);
    sendIntentRef.current = intent;
    try {
      const response = await fetchForSession(`${sessionPath}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.idempotencyKey,
        },
        body: JSON.stringify({ content: text, sendProtocolVersion: intent.sendProtocolVersion, ...(groupMode ? { characterId: intent.characterId } : {}),
          ...(intent.allowPaidImage ? { allowPaidImage: true } : {}) }),
      });
      // Quota exhausted: keep the user's input and surface the upgrade path (P0-C).
      if (response.status === 402) {
        setSendOutcomeUnknown(false);
        setUpgradeReason("messages");
        setStatus("Daily free message limit reached.");
        setContent(text);
        setMessages(dropOptimisticMessage);
        return;
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        const deletedSend = response.status === 409 && failure?.details?.reason === "chat_send_deleted";
        const expiredProtocol = response.status === 409 && failure?.details?.reason === "chat_send_protocol_required";
        if ((deletedSend || expiredProtocol) && sendIntentRef.current === intent) sendIntentRef.current = null;
        const updatedCharacterId = response.status === 410 && !groupMode ? chatReleaseChangedCharacterId(failure) : null;
        if (updatedCharacterId && await openUpdatedCharacterChat(updatedCharacterId, text)) return;
        if (response.status === 410) dispatchMetadata({ type: "continuation", continuation: updatedCharacterId ? "character_release_changed" : "character_unavailable" });
        setSendOutcomeUnknown(response.status >= 500);
        setStatus(updatedCharacterId
          ? "This Character was updated, so this chat is now read-only. Your message is still below. Open the Character again to continue in a new chat."
          : deletedSend
            ? "That message was deleted. Send again to make a new request."
            : expiredProtocol
              ? "This send request expired. Review your draft and send it again."
              : chatFailureCopy(failure, "Message failed to send. Please try again."));
        setContent(text);
        setMessages(dropOptimisticMessage);
        // A reply the page has not seen yet (a proactive check-in) can be the
        // one generating; show it now instead of on the next minute's poll.
        if (response.status === 409) {
          void delivery.refresh().catch(() => undefined);
        }
        return;
      }
      const payload = parseChatSendResponse(await response.json());
      sendIntentRef.current = null;
      setSendOutcomeUnknown(false);
      sendDelivery.receiveTurn(payload, localMessageId);
    } catch {
      // Network/parse failure: surface the error and restore the typed text so the
      // user's message is never silently lost (P0 — silent message loss).
      setStatus("Message failed to send. Please try again.");
      setSendOutcomeUnknown(true);
      setContent(text);
      setMessages(dropOptimisticMessage);
    } finally {
      setPending(false);
    }
  }

  // The old chat keeps its history; the Character's current chat receives the
  // unsent message. False means nothing moved and the caller keeps the text here.
  async function openUpdatedCharacterChat(updatedCharacterId: string, draft: string): Promise<boolean> {
    try {
      if (!receiptOwnerScope) return false;
      const response = await fetchForSession("/api/v1/chat/sessions", {
        method: "POST",
        // The draft belongs to this account; if another tab switched accounts, refuse.
        headers: { "content-type": "application/json", "x-idream-viewer-scope": receiptOwnerScope },
        body: JSON.stringify({ characterId: updatedCharacterId }),
      });
      if (!response.ok) return false;
      const nextId = parseChatSessionCreateResponse(await response.json()).session.id;
      if (!mountedRef.current) return false;
      if (nextId === id || !stashChatReleaseHandoff(nextId, draft)) return false;
      window.location.assign(`/chat/${encodeURIComponent(nextId)}`);
      return true;
    } catch {
      return false;
    }
  }

  function reportMessage(messageId: string) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    openReport({ kind: "record", targetType: "chat_message", targetId: messageId });
  }

  function beginEdit(messageId: string) {
    const message = messages.find(item => item.id === messageId);
    if (!message) return;
    const attempt = messages.find(reply => reply.role === "assistant" && reply.replyToMessageId === message.id)?.attempt;
    if (typeof attempt !== "number") {
      setStatus("Reload this chat before editing the message.");
      return;
    }
    setStatus(null);
    setDeleteConfirmMessageId(null);
    editIntentRef.current = null;
    setEditingTarget({ messageId: message.id, attempt, originalContent: message.content });
    setEditingContent(message.content);
  }

  function cancelEdit() {
    editIntentRef.current = null;
    setEditingTarget(null);
    setEditingContent("");
  }

  async function saveEditedMessage(allowPaidImage = false) {
    const next = editingContent.trim();
    if (!next || !editingTarget || editingPending) return;
    const previous = editIntentRef.current;
    const intent = previous?.content === next && previous.allowPaidImage === allowPaidImage
      ? previous : { content: next, allowPaidImage, idempotencyKey: crypto.randomUUID() };
    editIntentRef.current = intent;
    setStatus(null);
    setDeleteConfirmMessageId(null);
    setUpgradeReason(null);
    setEditingPending(true);
    stopVoice();
    try {
      const { messageId, attempt } = editingTarget;
      const result = await delivery.edit({ messageId, attempt, ...intent });
      if (result === "quota_exhausted") setUpgradeReason("messages");
      if (result === "applied") cancelEdit();
    } finally {
      setEditingPending(false);
    }
  }

  function revokeUnavailableSession(error: unknown) {
    const signedOut = isChatAuthError(error);
    const status = (error as { status?: unknown } | null)?.status;
    if (!signedOut && status !== 403 && status !== 404) return;
    voice.reset();
    delivery.reset();
    suspendGenerationReceipts(true);
    setReceiptOwnerScope(null);
    // Header, Scene, and drawers can outlive the ready-state branch.
    receiptOwnerScopeRef.current = null;
    sendIntentRef.current = null;
    setMessages([]);
    setContent("");
    dispatchMetadata({ type: "reset" });
    selectedSpeakerRef.current = null;
    setSessionsOpen(false);
    setMemoryOpen(false);
    media.closeVideoForm();
    setStatus(null);
    setLoadState(signedOut ? "signed-out" : "error");
  }

  function applySessionMetadata(session: ChatSession) {
    const intent = sendIntentRef.current;
    if (session.group && intent && session.messages.some(message => message.requestKey === intent.idempotencyKey)) {
      sendIntentRef.current = null;
      setSendOutcomeUnknown(false);
      setContent(current => current.trim() === intent.content ? "" : current);
    }
    resumeGenerationReceipts(session.ownerScope);
    setReceiptOwnerScope(session.ownerScope);
    setDeleteConfirmMessageId(null);
    selectedSpeakerRef.current = session.characterId ?? null;
    dispatchMetadata({ type: "session", session });
    if (session.status === "archived" || (session.continuation && session.continuation !== "available")) cancelEdit();
  }

  async function changeSpeaker(nextCharacterId: string) {
    if (!group || !group.members.some(member => member.characterId === nextCharacterId) || nextCharacterId === characterId
      || pending || hasGeneratingReply || speakerPending || sendOutcomeUnknown) return;
    const prior = selectedSpeakerRef.current;
    const read = delivery.context({ invalidate: true });
    selectedSpeakerRef.current = nextCharacterId;
    setSpeakerPending(true);
    stopVoice();
    try {
      if (!await read.refresh()) return;
      // INVARIANT: 只收回自己上一次的失败提示。无差别清空会吞掉切换期间提交给用户的回执。
      setStatus((current) => (current === SPEAKER_SELECT_FAILED ? null : current));
    } catch {
      if (read.isCurrent()) {
        selectedSpeakerRef.current = prior;
        setStatus(SPEAKER_SELECT_FAILED);
      }
    } finally { setSpeakerPending(false); }
  }

  // SPEC: Flip long-term memory for this session; optimistic, reconciled from the
  //       updated session row the BFF returns (raw, not {ok,data}).
  async function toggleMemory() {
    if (memoryPending) return;
    setStatus(null);
    setDeleteConfirmMessageId(null);
    const next = !memoryEnabled;
    setMemoryPending(true);
    delivery.context({ invalidate: true });
    try {
      const response = await fetchForSession(`/api/v1/chat/sessions/${encodeURIComponent(executionSessionId)}/memory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryEnabled: next }),
      });
      if (!response.ok) {
        setStatus("Couldn't update memory. Please try again.");
        return;
      }
      const row = (await response.json()) as { memoryEnabled?: boolean };
      dispatchMetadata({ type: "memory", enabled: typeof row.memoryEnabled === "boolean" ? row.memoryEnabled : next });
    } catch {
      setStatus("Couldn't update memory. Please try again.");
    } finally {
      setMemoryPending(false);
    }
  }

  async function deleteMessage(messageId: string) {
    setStatus(null);
    if (deleteConfirmMessageId !== messageId) {
      setDeleteConfirmMessageId(messageId);
      setStatus("Press Confirm delete to remove your message and the reply.");
      return;
    }
    stopVoice();
    delivery.context({ invalidate: true });
    try {
      const response = await fetchForSession(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        delivery.removeTurn(messageId);
        setDeleteConfirmMessageId(null);
      } else {
        setStatus(chatFailureCopy(
          await response.json().catch(() => null),
          "Couldn't delete the message. Please try again.",
        ));
        setDeleteConfirmMessageId(null);
      }
    } catch {
      setStatus("Couldn't delete the message. Please try again.");
      setDeleteConfirmMessageId(null);
    }
  }

  async function regenerate(messageId: string) {
    if (pending || hasGeneratingReply) return;
    setPending(true);
    stopVoice();
    setStatus(null);
    setDeleteConfirmMessageId(null);
    try {
      await delivery.regenerate(messageId);
    } finally {
      setPending(false);
    }
  }

  function jumpToLatest() {
    pinnedToBottomRef.current = true;
    setJumpToLatestVisible(false);
    scrollChatToEnd("smooth");
  }

  const handlers = useStableHandlers<ChatMessageHandlers>({
    beginEdit,
    cancelEdit,
    saveEdit: (allowPaidImage) => void saveEditedMessage(allowPaidImage),
    changeEdit: setEditingContent,
    report: reportMessage,
    remove: (messageId) => void deleteMessage(messageId),
    regenerate: (messageId) => void regenerate(messageId),
    play: (messageId, text) => void voice.play(messageId, text),
    confirmVoice: (confirmation) => void voice.play(confirmation.messageId, confirmation.text, confirmation.quote.quoteToken!),
    dismissVoice: voice.dismissConfirmation,
    retryAttachment: (attachment, authority?: GenerationQuoteAuthority) => media.retryImageAttachment(attachment, authority),
    refreshAttachments: media.refreshAfterAttachmentChange,
    addToIdentity: (mediaAssetId, sourceCharacterId) => void media.addAttachmentToIdentity(mediaAssetId, sourceCharacterId),
    identityFeedback: (mediaAssetId, feedback) => void media.recordAttachmentIdentityFeedback(mediaAssetId, feedback),
    moreLikeThis: (mediaAssetId) => void media.createAttachmentVariation(mediaAssetId),
    animate: (mediaAssetId, sourceCharacterId) => media.openVideoRequest(mediaAssetId, undefined, sourceCharacterId),
  });
  const paymentHref = upgradeHrefForChatSession(id, groupMode);
  const attachmentContext = useMemo<ChatAttachmentContext>(() => ({
    conversationId: id,
    executionSessionId,
    characterId,
    canUpdateIdentity,
    receiptOwnerScope,
    retryingImageIds: media.retryingImageIds,
    variationPendingMediaId: media.variationPendingMediaId,
    videoEnabled,
    paymentHref,
    fetchForViewer: fetchForSession,
  }), [id, executionSessionId, characterId, canUpdateIdentity, receiptOwnerScope, media.retryingImageIds,
    media.variationPendingMediaId, videoEnabled, paymentHref, fetchForSession]);

  const { latestUserMessageId, latestReplyInProgress, latestCompletedReply } = summary;
  const videoSources = chatVideoSources(messages, { sessionId: executionSessionId, characterId });
  const videoForm = media.videoForm;

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/chat" />
        <section className="flex min-w-0 flex-1 flex-col px-4 py-6 pb-24 md:px-[60px]">
          {/* On short screens the group controls and expanded composer can overlap. Let the header scroll away. */}
          <header className="sticky top-0 z-20 -mx-4 border-b border-white/10 bg-[rgb(13,13,13)] px-4 pb-2 pt-2 md:mx-0 md:px-0 [@media(max-height:480px)]:static [@media(max-height:480px)]:z-auto">
            <Link
              className="mb-2 inline-flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)] hover:text-white"
              href={groupMode ? "/chat/groups" : "/"}
            >
              <ArrowLeft className="h-4 w-4" />
              {groupMode ? "Your group chats" : "Explore"}
            </Link>
            <div className="flex min-w-0 items-center gap-3">
              <ChatHeaderAvatars
                className={group ? undefined : "xl:hidden"}
                images={group
                  ? group.members.flatMap(member => memberImages[member.characterId] ? [{ id: member.characterId, name: member.name, url: memberImages[member.characterId] }] : [])
                  : characterImage ? [{ id: characterId || "character", name: title, url: characterImage }] : []}
              />
              <h1 className="line-clamp-2 min-w-0 break-words text-[22px] font-black leading-tight md:text-[28px]">{title}</h1>
            </div>
            {loadState === "ready" && (<>
              {group ? <GroupSpeakerControls members={group.members} selectedCharacterId={characterId} disabled={pending || hasGeneratingReply || speakerPending || conversationArchived || sendOutcomeUnknown} onSelect={next => void changeSpeaker(next)} /> : null}
              <ChatHeaderControls
                generateHref={chatGenerationHref({ characterId, sessionId: executionSessionId, message: latestCompletedReply })}
                generationUnavailable={continuation !== "available"}
                memoryEnabled={memoryEnabled}
                memoryPending={memoryPending}
                onToggleMemory={toggleMemory}
                onOpenSessions={() => groupMode ? window.location.assign("/chat/groups") : setSessionsOpen(true)}
                onOpenMemory={() => setMemoryOpen(true)}
              />
            </>)}
          </header>
          <ChatSceneLine messages={messages} characterId={group ? characterId ?? undefined : undefined} />
          {loadState === "ready" ? (
            <>
              <p className="mt-2 text-xs leading-4 text-[rgb(170,170,170)]">
                {memoryEnabled
                  ? "Memory on: this character remembers details across your chats."
                  : "No-memory: this character won't read or write long-term memory. Your current chat history stays until you delete the session."}
              </p>
              {group ? (
                <p className="mt-1 text-xs leading-5 text-[rgb(170,170,170)]">
                  @mention a character to choose who replies. Memory and preferences follow the selected character.
                </p>
              ) : null}
              {group && sendOutcomeUnknown ? <p role="status" className="mt-3 text-sm text-white/80">The last request is unconfirmed. Retry the same message to check it before choosing another speaker.</p> : null}
              {conversationArchived ? <p className="mt-3 text-sm text-white/80">This conversation is archived. Its history stays readable.{!group && characterId ? <> <Link className="font-bold underline" href={`/characters/${encodeURIComponent(characterId)}`}>Start a new chat</Link></> : group ? <> <Link className="font-bold underline" href="/chat/groups">Start a new group</Link></> : null}</p> : null}
              <ConversationPreferences key={executionSessionId} sessionId={executionSessionId} />
              {videoEnabled ? (
                <button type="button" className="mt-3 inline-flex min-h-11 items-center gap-2 self-start rounded-full border border-white/20 px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={!receiptOwnerScope} onClick={() => media.openVideoRequest()}>
                  <Video className="size-4" />Video
                </button>
              ) : null}
              {videoForm && videoForm.conversationId === id && videoForm.ownerScope === receiptOwnerScope ? <ChatVideoComposer
                key={`${videoForm.ownerScope}:${videoForm.characterId}:${videoForm.sourceId ?? ""}:${videoForm.prompt ?? ""}`}
                sources={videoSources.filter(source => source.characterId === videoForm.characterId)} initialSourceId={videoForm.sourceId} initialPrompt={videoForm.prompt}
                ownerScope={videoForm.ownerScope} onClose={media.closeVideoForm} onSubmit={media.submitVideoRequest}
              /> : null}
              {receiptWarning ? <p role="status" className="mt-3 text-sm text-white/80">{receiptWarning}</p> : null}
              {generationReceipts.length > 0 ? (
                <section className="mt-4 rounded-xl border border-white/15 p-4" aria-label="Unconfirmed generation requests">
                  <h2 className="font-bold">Check your original requests</h2>
                  <p className="mt-1 text-sm text-white/80">A response was interrupted. Checking keeps the original request and price; it does not start another job.</p>
                  <ul className="mt-3 space-y-3">
                    {generationReceipts.map((receipt) => {
                      const quote = receipt.body.quoteAuthority as GenerationQuoteAuthority;
                      const checking = checkingReceiptKeys.has(receipt.key);
                      return <li key={receipt.key} data-pending-request-key={receipt.key} className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{receipt.kind === "generation_retry" ? "Media retry" : receipt.kind === "chat_video" ? "Chat video" : receipt.kind === "media_variation" ? "Image variation" : receipt.kind === "media_enhancement" ? "Image enhancement" : "Generation"} · {quote.costDreamcoins} coins</p>
                        </div>
                        <button type="button" className="min-h-11 rounded-full bg-white px-4 py-2 text-sm font-bold text-[rgb(13,13,13)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
                          disabled={checking} onClick={() => void media.checkGenerationReceipt(receipt)}>{checking ? "Checking…" : "Check original request"}</button>
                      </li>;
                    })}
                  </ul>
                </section>
              ) : null}
              <ChatMessageList
                messages={messages}
                group={group}
                characterId={characterId}
                readOnly={conversationReadOnly}
                hasGeneratingReply={hasGeneratingReply}
                latestUserMessageId={latestUserMessageId}
                latestReplyInProgress={latestReplyInProgress}
                editingTarget={editingTarget}
                editingContent={editingContent}
                editingPending={editingPending}
                deleteConfirmMessageId={deleteConfirmMessageId}
                actionsPending={pending || editingPending || voiceCall.active}
                voicePreparingIds={voice.preparingIds}
                voicePlayingId={voice.playingId}
                voiceConfirmation={voice.confirmation}
                attachmentContext={attachmentContext}
                handlers={handlers}
                listRef={messageListRef}
                endRef={messagesEndRef}
              />
              {jumpToLatestVisible ? (
                <button
                  className="sticky bottom-36 z-10 self-center rounded-full bg-white px-3 py-2 text-[12px] font-bold text-[rgb(13,13,13)] shadow-[0_2px_12px_rgba(0,0,0,0.45)] md:bottom-16"
                  data-testid="chat-jump-to-latest"
                  onClick={jumpToLatest}
                  type="button"
                >
                  <ArrowDown className="mr-1.5 inline h-3.5 w-3.5" />
                  New messages
                </button>
              ) : null}
              {/* SPEC: 会话状态必须和输入框一起钉在视口底部。
                  INTENT: 输入框是 sticky，状态段落原本跟在它后面的普通流里，长会话时会被顶到
                  文档底部、永远在视口外——点「Play voice」被套餐拦下、日额度用尽、安全策略拦截、
                  发送失败这些提示用户一条都看不到，表现得像按钮没反应。 */}
              <div ref={composerDockRef} className="sticky bottom-20 z-10 mt-4 bg-[rgb(13,13,13)] md:bottom-0">
                {status ? (
                  <p
                    aria-live="polite"
                    className="pb-1 text-[13px] font-semibold text-[#ff7ac8]"
                    data-testid="chat-session-status"
                    role="status"
                  >
                    {status}
                    {upgradeReason ? (
                      <>
                        {" "}
                        <Link className="underline hover:text-white" href={paymentHref}>
                          {chatUpgradeLinkLabel(upgradeReason)}
                        </Link>
                        .
                      </>
                    ) : null}
                  </p>
                ) : null}
              <VoiceInputStatus voice={voiceInput} />
              {!conversationArchived && continuation !== "available" ? (
                <p role="status" className="mb-3 text-sm text-white/80" data-testid="chat-continuation-status">
                  {continuation === "character_release_changed"
                    ? <>This Character was updated. This conversation stays readable. {groupMode
                      ? <Link className="font-bold underline" href="/chat/groups">Start a new group</Link>
                      : <button type="button" className="font-bold underline disabled:opacity-50" disabled={pending || !receiptOwnerScope || !characterId} onClick={async () => {
                        if (!characterId) return;
                        setPending(true);
                        try {
                          if (!await openUpdatedCharacterChat(characterId, content)) setStatus("Couldn't open the current chat. Your draft is still here. Try again.");
                        } finally { setPending(false); }
                      }}>Continue in a new chat</button>}</>
                    : <>This Character is currently unavailable. Your conversation stays readable. {groupMode ? "Choose another speaker to continue." : <Link className="font-bold underline" href="/">Explore Characters</Link>}</>}
                </p>
              ) : null}
              {!groupMode ? <VoiceCallControls voice={voiceCall} open={voiceCallOpen} onClose={() => setVoiceCallOpen(false)} disabled={pending || hasGeneratingReply || conversationReadOnly || voiceInput.blocksSend} /> : null}
              <ChatComposer
                inputId={`chat-message-${id}`}
                value={content}
                placeholder={group ? "Message or @name…" : "Message..."}
                disabled={conversationReadOnly}
                readOnly={pending || voiceInput.readOnly || voiceCall.active || (groupMode && sendOutcomeUnknown)}
                canSend={canSend}
                generating={hasGeneratingReply}
                stopping={stoppingReply}
                composerRef={composerRef}
                callButton={!groupMode ? <VoiceCallButton voice={voiceCall} open={voiceCallOpen} onToggle={() => setVoiceCallOpen(value => !value)} /> : null}
                voiceInputButton={<VoiceInputButton voice={voiceInput} disabled={voiceCall.active || pending || speakerPending || conversationReadOnly || (groupMode && sendOutcomeUnknown)} />}
                onChange={(next) => {
                  setContent(next);
                  const mentioned = group ? mentionedGroupCharacter(next, group.members) : null;
                  if (mentioned) void changeSpeaker(mentioned);
                }}
                onSubmit={submit}
                onStop={() => void delivery.stop()}
              />
              </div>
            </>
          ) : (
            <ChatSessionUnavailablePanel loadState={viewer.error ? "error" : loadState} sessionId={id} groupMode={groupMode}
              accountError={viewer.error} onRetryAccount={() => void viewer.revalidate()} />
          )}
        </section>
        {loadState === "ready" ? (
          <ChatCompanionPortrait
            characterId={group ? null : characterId}
            image={group ? (characterId ? memberImages[characterId] ?? null : null) : characterImage}
            name={group ? group.members.find(member => member.characterId === characterId)?.name ?? title : title}
          />
        ) : null}
      </div>
      <MobileBottomNav activeHref="/chat" />
      <ChatSessionListDrawer
        fetchForViewer={fetchForSession}
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        currentSessionId={id}
        onArchived={sessionId => {
          if (sessionId === id) { dispatchMetadata({ type: "archived" }); cancelEdit(); }
        }}
      />
      <MemoryPanel
        key={executionSessionId}
        fetchForViewer={fetchForSession}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        characterId={characterId}
        sessionId={executionSessionId}
        groupConversation={Boolean(group)}
        memoryEnabled={memoryEnabled}
        memoryPending={memoryPending}
        onToggleMemory={toggleMemory}
        onProactiveChange={(enabled) => dispatchMetadata({ type: "proactive", enabled })}
      />
      {reportDialog}
    </main>
  );
}

function ChatSessionUnavailablePanel({
  loadState,
  sessionId,
  groupMode = false,
  accountError,
  onRetryAccount,
}: Readonly<{ loadState: Exclude<ChatLoadState, "ready">; sessionId: string; groupMode?: boolean; accountError?: string | null; onRetryAccount?: () => void }>) {
  const loginTarget = `/chat/${groupMode ? "groups/" : ""}${encodeURIComponent(sessionId)}`;

  if (loadState === "loading") {
    return (
      <div className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-[rgb(114,113,112)]" />
        <h2 className="mt-4 text-[22px] font-black uppercase text-white">Loading chat</h2>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]" role="status">
          Fetching the latest messages and session controls.
        </p>
      </div>
    );
  }

  if (loadState === "signed-out") {
    return (
      <div
        className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
        data-testid="chat-session-auth-required"
      >
        <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
        <h2 className="mt-4 text-[22px] font-black uppercase text-white">
          Log in to continue this chat
        </h2>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
          This conversation is private. Log in to reopen it, or join free to start from your chat
          hub.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
            href={authHrefForTarget("/login", loginTarget)}
          >
            Log in
          </Link>
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
            href={authHrefForTarget("/signup", "/chat")}
          >
            Join free
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
      data-testid="chat-session-unavailable"
    >
      <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
      <h2 className="mt-4 text-[22px] font-black uppercase text-white">Chat unavailable</h2>
      <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]" role={accountError ? "alert" : undefined}>
        {accountError || "This conversation could not be loaded. Open your chat hub or start a new conversation."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {accountError ? <button type="button" onClick={onRetryAccount}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]">Retry</button> : null}
        <Link
          className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
          href="/chat"
        >
          Chat hub
        </Link>
        <Link
          className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
          href="/"
        >
          Explore
        </Link>
      </div>
    </div>
  );
}

// SPEC: 头部下方一行小字显示当前场景（最新一条带 scene 的回复）；没有场景就不渲染。
// 群聊每个角色各有自己的场景，只看当前发言角色的回复。
export function currentChatScene(messages: ChatMessage[], characterId?: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.scene) continue;
    if (characterId && message.characterId !== characterId) continue;
    return message.scene;
  }
  return null;
}

function ChatSceneLine({ messages, characterId }: { messages: ChatMessage[]; characterId?: string }) {
  const scene = currentChatScene(messages, characterId);
  const parts = scene ? [scene.location, scene.time, scene.emotionalBeat].filter((part): part is string => Boolean(part?.trim())) : [];
  if (!parts.length) return null;
  return (
    <p className="mt-2 text-[12px] font-medium leading-5 text-white/55" data-testid="chat-scene">
      Scene · {parts.join(" · ")}
    </p>
  );
}

// 头部只放角色已有的封面小图；群聊叠成一组，最多 5 个。没有图就不占位。
// 宽屏的一对一聊天由右侧立绘承担在场感，头像在那里隐藏，避免同一张脸出现两次。
function ChatHeaderAvatars({ images, className }: { images: Array<{ id: string; name: string; url: string }>; className?: string }) {
  if (!images.length) return null;
  return (
    <div className={`flex shrink-0 -space-x-3 ${className ?? ""}`} data-testid="chat-header-avatars">
      {images.slice(0, 5).map(image => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt={image.name}
          className="h-14 w-14 rounded-full border-2 border-[rgb(13,13,13)] bg-[rgb(36,36,36)] object-cover object-top"
          key={image.id}
          src={image.url}
        />
      ))}
    </div>
  );
}

// SPEC: 宽屏（xl+）右侧钉一列正在说话的角色立绘；群聊跟随当前发言者。
// INTENT: 陪伴产品的对象是「人」，聊天时只剩 44px 头像等于让角色从对话里消失。
// 窄屏不加：竖屏空间要留给消息和输入框，头像放大到 56px 作为在场提示。
function ChatCompanionPortrait({ image, name, characterId }: { image: string | null; name: string; characterId: string | null }) {
  if (!image) return null;
  const portrait = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={name} className="h-full w-full object-cover object-top" src={image} />
      <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,rgba(8,8,8,.86)_0%,transparent_100%)] px-5 pb-5 pt-16">
        <p className="text-[22px] font-black uppercase leading-6 text-white">{name}</p>
        {characterId ? <p className="mt-1 text-[12px] font-bold text-white/70">View profile</p> : null}
      </div>
    </>
  );
  const frameClass = "relative block aspect-[3/4] w-full overflow-hidden rounded-[24px] border border-white/10 bg-[rgb(36,36,36)]";
  return (
    <aside className="hidden w-[380px] shrink-0 py-6 pr-[60px] xl:block 2xl:w-[460px]" data-testid="chat-companion-portrait">
      <div className="sticky top-6">
        {characterId ? (
          <Link className={`${frameClass} transition-colors hover:border-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff7ac8]`} href={`/characters/${encodeURIComponent(characterId)}`}>
            {portrait}
          </Link>
        ) : <div className={frameClass}>{portrait}</div>}
      </div>
    </aside>
  );
}
