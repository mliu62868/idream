"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bug,
  CheckCircle2,
  Crown,
  ExternalLink,
  LifeBuoy,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
  Scale,
  Send,
  Sparkles,
  ThumbsUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  parseFeedbackItemResponse,
  parseFeedbackItemsResponse,
  parseViewerAuthorityResponse,
  type PublicFeedbackItem as FeedbackItem,
} from "@/lib/public-api-contracts";
import {
  APPEAL_TARGET_TYPES,
  PRODUCT_FEEDBACK_CATEGORIES,
  PRODUCT_FEEDBACK_STATUSES,
  SUPPORT_REQUEST_CATEGORIES,
  isCatalogMember,
  type AppealTargetType,
  type ProductFeedbackCategory,
  type ProductFeedbackStatus,
  type SupportRequestCategory,
} from "@idream/shared/catalog";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import {
  claimDraftTransfer,
  draftTransferPath,
  stashDraftTransfer,
} from "./draft-transfer";
import { fetchViewerScope } from "./viewer-auth";
import { isRecord } from "./workspace-helpers";

type SupportPayload = {
  ok?: boolean;
  data?: {
    request?: {
      id: string;
      ticketId: string;
      status: string;
      category: string;
    };
  };
  error?: { message?: string };
};

type AppealPayload = {
  ok?: boolean;
  data?: {
    appeal?: {
      id: string;
      status: string;
      targetType: string;
      targetId: string;
    };
  };
  error?: { message?: string };
};

// Values come from the catalog; only the English copy lives here. The Record type
// makes a catalog addition a compile error instead of a silently missing option.
type SupportCategory = SupportRequestCategory;

const supportCategoryLabels: Record<SupportCategory, string> = {
  account: "Account",
  billing: "Billing",
  generation: "Generation",
  chat: "Chat",
  bug: "Bug",
  feature: "Feature",
  other: "Other",
};

const categories = SUPPORT_REQUEST_CATEGORIES.map((value) => ({
  label: supportCategoryLabels[value],
  value,
}));

type SupportDraft = {
  category: SupportCategory;
  subject: string;
  description: string;
  diagnosticConsent: boolean;
};

const SUPPORT_DRAFT_STORAGE_KEY = "ourdream.helpdesk.supportDraft.v1";
const INITIAL_SUPPORT_DRAFT: SupportDraft = {
  category: "generation",
  subject: "",
  description: "",
  diagnosticConsent: true,
};

const appealTargetTypeLabels: Record<AppealTargetType, string> = {
  character: "Character",
  media: "Media",
  feed_item: "Feed item",
  chat_message: "Chat message",
  user_profile: "User profile",
  moderation_decision: "Moderation decision",
  safety_issue: "Safety issue",
  copyright_likeness: "Copyright / likeness",
};

const appealTargetTypes = APPEAL_TARGET_TYPES.map((value) => ({
  label: appealTargetTypeLabels[value],
  value,
}));

type FeedbackCategory = ProductFeedbackCategory;

const feedbackCategoryLabels: Record<FeedbackCategory, string> = {
  feature: "Feature",
  improvement: "Improvement",
  bug: "Bug",
};

const feedbackCategories = PRODUCT_FEEDBACK_CATEGORIES.map((value) => ({
  label: feedbackCategoryLabels[value],
  value,
}));

type FeedbackDraft = {
  category: FeedbackCategory;
  title: string;
  description: string;
};

type AppealDraft = {
  targetType: AppealTargetType;
  targetId: string;
  decisionId: string;
  text: string;
};

type PendingFeedbackVote = {
  itemId: string;
  action: "vote" | "unvote";
  title: string;
};

const FEEDBACK_DRAFT_STORAGE_KEY = "ourdream.helpdesk.feedbackDraft.v1";
const APPEAL_DRAFT_STORAGE_KEY = "ourdream.helpdesk.appealDraft.v1";
const INITIAL_FEEDBACK_DRAFT: FeedbackDraft = {
  category: "feature",
  title: "",
  description: "",
};
const INITIAL_APPEAL_DRAFT: AppealDraft = {
  targetType: "character",
  targetId: "",
  decisionId: "",
  text: "",
};

const faqs = [
  {
    question: "I cannot start chat or generation.",
    answer:
      "Check that the age gate is accepted and that you are signed in. Generation requires enough dreamcoins and an available model; plan entitlements may control access to specific models.",
  },
  {
    question: "Where can I see billing and access?",
    answer:
      "Open Profile → Billing & access to see your current plan, balance, and benefits end date. Current purchases are prepaid for one selected period and do not renew automatically.",
  },
  {
    question: "How do I report a character or media item?",
    answer:
      "Use the Report action on the character, feed item, community card, or generated media. Those reports go to the moderation queue.",
  },
  {
    question: "Can support inspect my account context?",
    answer:
      "Only attach diagnostics when you want the team to use account, browser, and recent workflow metadata to debug your issue.",
  },
] as const;

const roadmapItems = [
  {
    icon: Bug,
    title: "Bugs",
    copy: "Submit reproducible product issues with the affected workflow and expected result.",
  },
  {
    icon: Sparkles,
    title: "Features",
    copy: "Premium feedback gets routed into the beta product backlog below for voting and triage.",
  },
  {
    icon: Crown,
    title: "Changelog",
    copy: "Beta release notes highlight creator, chat, generation, billing, and community improvements.",
  },
] as const;

export function HelpDeskWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [supportDraft, setSupportDraft] = useState<SupportDraft>(INITIAL_SUPPORT_DRAFT);
  const [status, setStatus] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [feedbackLoadError, setFeedbackLoadError] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState("");
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>(INITIAL_FEEDBACK_DRAFT);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackVotingId, setFeedbackVotingId] = useState("");
  const [pendingFeedbackVote, setPendingFeedbackVote] = useState<PendingFeedbackVote | null>(null);
  const pendingFeedbackVoteApplyingRef = useRef<string | null>(null);
  const [appealDraft, setAppealDraft] = useState<AppealDraft>(INITIAL_APPEAL_DRAFT);
  const [appealStatus, setAppealStatus] = useState("");
  const [appealSubmitting, setAppealSubmitting] = useState(false);
  const [viewerScope, setViewerScope] = useState<string | null>(null);
  const viewerScopeRef = useRef<string | null>(null);
  const hydratedViewerScopeRef = useRef<string | null>(null);
  const { category, description, diagnosticConsent, subject } = supportDraft;
  const {
    category: feedbackCategory,
    description: feedbackDescription,
    title: feedbackTitle,
  } = feedbackDraft;
  const {
    decisionId: appealDecisionId,
    targetId: appealTargetId,
    targetType: appealTargetType,
    text: appealText,
  } = appealDraft;

  const setSupportDraftField = useCallback(
    <K extends keyof SupportDraft>(key: K, value: SupportDraft[K]) => {
      setSupportDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const setFeedbackDraftField = useCallback(
    <K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]) => {
      setFeedbackDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const setAppealDraftField = useCallback(
    <K extends keyof AppealDraft>(key: K, value: AppealDraft[K]) => {
      setAppealDraft((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const resolveViewerScope = useCallback(async () => {
    if (viewerScopeRef.current) return viewerScopeRef.current;
    const scope = await fetchViewerScope();
    viewerScopeRef.current = scope;
    setViewerScope(scope);
    return scope;
  }, []);

  const canSubmit = useMemo(
    () => subject.trim().length >= 3 && description.trim().length >= 10 && !submitting,
    [description, subject, submitting],
  );

  const canSubmitFeedback = useMemo(
    () =>
      feedbackTitle.trim().length >= 3 &&
      feedbackDescription.trim().length >= 10 &&
      !feedbackSubmitting,
    [feedbackDescription, feedbackSubmitting, feedbackTitle],
  );

  const canSubmitAppeal = useMemo(
    () =>
      appealTargetId.trim().length >= 3 &&
      appealText.trim().length >= 10 &&
      !appealSubmitting,
    [appealSubmitting, appealTargetId, appealText],
  );

  const loadFeedbackItems = useCallback(async () => {
    if (!ageGateAccepted) return;
    setFeedbackLoading(true);
    setFeedbackLoadError("");
    try {
      const response = await fetch("/api/v1/feedback/items", { method: "GET" });
      const raw = await response.json();
      if (!response.ok) {
        setFeedbackItems([]);
        setFeedbackLoadError(
          apiErrorMessage(raw) ?? "Could not load feature voting.",
        );
        return;
      }
      setFeedbackItems(parseFeedbackItemsResponse(raw).items);
    } catch {
      setFeedbackItems([]);
      setFeedbackLoadError("Could not load feature voting.");
    } finally {
      setFeedbackLoading(false);
    }
  }, [ageGateAccepted]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch("/api/v1/me", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Viewer authority could not load.");
        const payload = parseViewerAuthorityResponse(await response.json());
        const user = payload.user;
        const nextScope =
          user
            ? `user:${user.id}`
            : typeof payload.anonymousId === "string"
              ? `anonymous:${payload.anonymousId}`
              : null;
        if (!nextScope) throw new Error("Viewer authority was incomplete.");
        viewerScopeRef.current = nextScope;
        setViewerScope(nextScope);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        viewerScopeRef.current = null;
        setViewerScope(null);
        setStatus("Viewer authority could not load. Draft recovery is paused.");
      });
    return () => controller.abort();
  }, [ageGateAccepted]);

  useEffect(() => {
    if (!viewerScope) return;
    const previousScope = hydratedViewerScopeRef.current;
    hydratedViewerScopeRef.current = viewerScope;
    if (previousScope && previousScope !== viewerScope) {
      setSupportDraft(INITIAL_SUPPORT_DRAFT);
      setFeedbackDraft(INITIAL_FEEDBACK_DRAFT);
      setAppealDraft(INITIAL_APPEAL_DRAFT);
      setPendingFeedbackVote(null);
      pendingFeedbackVoteApplyingRef.current = null;
      setStatus("");
      setFeedbackStatus("");
      setAppealStatus("");
    }

    const resumed = consumeHelpDeskResume(viewerScope);
    const restoredSupport =
      resumed?.kind === "support"
        ? parseSupportDraft(JSON.stringify(resumed.value))
        : loadSupportDraft(viewerScope);
    const restoredFeedback =
      resumed?.kind === "feedback"
        ? parseFeedbackDraft(JSON.stringify(resumed.value))
        : loadFeedbackDraft(viewerScope);
    const restoredAppeal =
      resumed?.kind === "appeal"
        ? parseAppealDraft(JSON.stringify(resumed.value))
        : loadAppealDraft(viewerScope);
    const restoredVote =
      resumed?.kind === "vote" && viewerScope.startsWith("user:")
        ? parsePendingFeedbackVote(JSON.stringify(resumed.value))
        : null;
    if (resumed?.kind === "support" && restoredSupport) {
      if (shouldClearTransferredHelpDeskDraft({
        saved: saveSupportDraft(viewerScope, restoredSupport),
        sourceScope: resumed.sourceScope,
        targetScope: viewerScope,
      })) {
        clearSupportDraft(resumed.sourceScope);
      }
    }
    if (resumed?.kind === "feedback" && restoredFeedback) {
      if (shouldClearTransferredHelpDeskDraft({
        saved: saveFeedbackDraft(viewerScope, restoredFeedback),
        sourceScope: resumed.sourceScope,
        targetScope: viewerScope,
      })) {
        clearFeedbackDraft(resumed.sourceScope);
      }
    }
    if (resumed?.kind === "appeal" && restoredAppeal) {
      if (shouldClearTransferredHelpDeskDraft({
        saved: saveAppealDraft(viewerScope, restoredAppeal),
        sourceScope: resumed.sourceScope,
        targetScope: viewerScope,
      })) {
        clearAppealDraft(resumed.sourceScope);
      }
    }

    const timer = window.setTimeout(() => {
      if (restoredSupport) {
        setSupportDraft(restoredSupport);
        setStatus("Your support draft was restored. Submit it when ready.");
      }
      if (restoredFeedback) {
        setFeedbackDraft(restoredFeedback);
        setFeedbackStatus("Your roadmap draft was restored. Submit it when ready.");
      }
      if (restoredAppeal) {
        setAppealDraft(restoredAppeal);
        setAppealStatus("Your appeal draft was restored. Submit it when ready.");
      }
      if (restoredVote) setPendingFeedbackVote(restoredVote);
      void loadFeedbackItems();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFeedbackItems, viewerScope]);

  useEffect(() => {
    const draft = appealDraftFromSearch(window.location.search);
    if (!draft) return;

    const timer = window.setTimeout(() => {
      setAppealDraft(draft);
      setAppealStatus("Appeal details were prefilled from your selected item.");
      window.requestAnimationFrame(() => {
        document.getElementById("appeals")?.scrollIntoView({ block: "start" });
        document.querySelector<HTMLElement>('[name="appealText"]')?.focus({ preventScroll: true });
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (
      !pendingFeedbackVote ||
      !viewerScope?.startsWith("user:") ||
      feedbackLoading ||
      pendingFeedbackVoteApplyingRef.current === pendingFeedbackVote.itemId ||
      !feedbackItems.some((item) => item.id === pendingFeedbackVote.itemId)
    ) {
      return;
    }

    const vote = pendingFeedbackVote;
    let cancelled = false;

    async function applyPendingVote() {
      try {
        const response = await fetch(`/api/v1/feedback/items/${vote.itemId}/vote`, {
          method: vote.action === "unvote" ? "DELETE" : "POST",
        });
        const raw = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          if (response.status === 401) {
            setPendingFeedbackVote(null);
            setFeedbackStatus("Sign in to finish voting on roadmap items.");
            return;
          }
          setPendingFeedbackVote(null);
          setFeedbackStatus(
            feedbackErrorMessage(response.status, apiErrorMessage(raw)),
          );
          return;
        }
        const item = parseFeedbackItemResponse(raw).item;
        setFeedbackItems((items) => upsertFeedbackItem(items, item));
        setFeedbackStatus(vote.action === "unvote" ? "Vote removed." : "Vote counted.");
        setPendingFeedbackVote(null);
      } catch {
        if (!cancelled) {
          setPendingFeedbackVote(null);
          setFeedbackStatus("Vote failed. Try again.");
        }
      } finally {
        if (!cancelled) {
          setFeedbackVotingId("");
        }
        if (pendingFeedbackVoteApplyingRef.current === vote.itemId) {
          pendingFeedbackVoteApplyingRef.current = null;
        }
      }
    }

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      pendingFeedbackVoteApplyingRef.current = vote.itemId;
      setFeedbackVotingId(vote.itemId);
      setFeedbackStatus("Finishing your roadmap vote...");
      void applyPendingVote();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [feedbackItems, feedbackLoading, pendingFeedbackVote, viewerScope]);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setStatus("");
    setTicketId("");
    try {
      const response = await fetch("/api/v1/support/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          subject: subject.trim(),
          description: description.trim(),
          diagnosticConsent,
          sourcePath: window.location.pathname,
        }),
      });
      const payload = (await response.json()) as SupportPayload;
      if (!response.ok || payload.ok === false) {
        if (response.status === 401) {
          const scope = await resolveViewerScope().catch(() => null);
          if (!scope) {
            setStatus("Viewer authority could not be confirmed. Refresh and try again.");
            return;
          }
          saveSupportDraft(scope, supportDraft);
          window.location.assign(
            authHrefForTarget(
              "/signup",
              helpDeskAuthReturnTarget(scope, "support", supportDraft),
            ),
          );
          return;
        }
        setStatus(helpdeskErrorMessage(response.status, payload.error?.message));
        return;
      }

      const request = payload.data?.request;
      setTicketId(request?.ticketId ?? "");
      setStatus(`Support request ${request?.ticketId ?? "received"} received.`);
      if (viewerScopeRef.current) clearSupportDraft(viewerScopeRef.current);
      setSupportDraft(INITIAL_SUPPORT_DRAFT);
    } catch {
      setStatus("Support request failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFeedbackItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitFeedback) return;

    setFeedbackSubmitting(true);
    setFeedbackStatus("");
    try {
      const response = await fetch("/api/v1/feedback/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category: feedbackCategory,
          title: feedbackTitle.trim(),
          description: feedbackDescription.trim(),
        }),
      });
      const raw = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          const scope = await resolveViewerScope().catch(() => null);
          if (!scope) {
            setFeedbackStatus("Viewer authority could not be confirmed. Refresh and try again.");
            return;
          }
          saveFeedbackDraft(scope, feedbackDraft);
          window.location.assign(
            authHrefForTarget(
              "/signup",
              helpDeskAuthReturnTarget(scope, "feedback", feedbackDraft),
            ),
          );
          return;
        }
        setFeedbackStatus(
          feedbackErrorMessage(response.status, apiErrorMessage(raw)),
        );
        return;
      }
      const item = parseFeedbackItemResponse(raw).item;
      setFeedbackItems((items) => upsertFeedbackItem(items, item));
      setFeedbackStatus("Feature idea submitted and your vote was counted.");
      if (viewerScopeRef.current) clearFeedbackDraft(viewerScopeRef.current);
      setFeedbackDraft(INITIAL_FEEDBACK_DRAFT);
    } catch {
      setFeedbackStatus("Feature idea failed. Try again.");
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  async function toggleFeedbackVote(item: FeedbackItem) {
    if (feedbackVotingId) return;
    setFeedbackVotingId(item.id);
    setFeedbackStatus("");
    try {
      const response = await fetch(`/api/v1/feedback/items/${item.id}/vote`, {
        method: item.userVoted ? "DELETE" : "POST",
      });
      const raw = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          const scope = await resolveViewerScope().catch(() => null);
          const vote = {
            itemId: item.id,
            action: item.userVoted ? "unvote" : "vote",
            title: item.title,
          } satisfies PendingFeedbackVote;
          if (!scope) {
            setFeedbackStatus("Viewer authority could not be confirmed. Refresh and try again.");
            return;
          }
          window.location.assign(
            authHrefForTarget(
              "/signup",
              helpDeskAuthReturnTarget(scope, "vote", vote),
            ),
          );
          return;
        }
        setFeedbackStatus(
          feedbackErrorMessage(response.status, apiErrorMessage(raw)),
        );
        return;
      }
      const next = parseFeedbackItemResponse(raw).item;
      setFeedbackItems((items) => upsertFeedbackItem(items, next));
      setFeedbackStatus(item.userVoted ? "Vote removed." : "Vote counted.");
    } catch {
      setFeedbackStatus("Vote failed. Try again.");
    } finally {
      setFeedbackVotingId("");
    }
  }

  async function submitAppeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitAppeal) return;

    setAppealSubmitting(true);
    setAppealStatus("");
    try {
      const response = await fetch("/api/v1/appeals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: appealTargetType,
          targetId: appealTargetId.trim(),
          originalDecisionId: appealDecisionId.trim() || undefined,
          appealText: appealText.trim(),
        }),
      });
      const payload = (await response.json()) as AppealPayload;
      if (!response.ok || payload.ok === false || !payload.data?.appeal) {
        if (response.status === 401) {
          const scope = await resolveViewerScope().catch(() => null);
          if (!scope) {
            setAppealStatus("Viewer authority could not be confirmed. Refresh and try again.");
            return;
          }
          saveAppealDraft(scope, appealDraft);
          window.location.assign(
            authHrefForTarget(
              "/signup",
              helpDeskAuthReturnTarget(scope, "appeal", appealDraft),
            ),
          );
          return;
        }
        setAppealStatus(appealErrorMessage(response.status, payload.error?.message));
        return;
      }
      setAppealStatus(`Appeal ${payload.data.appeal.id} submitted.`);
      if (viewerScopeRef.current) clearAppealDraft(viewerScopeRef.current);
      setAppealDraft(INITIAL_APPEAL_DRAFT);
    } catch {
      setAppealStatus("Appeal failed. Try again.");
    } finally {
      setAppealSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-8 md:px-[60px] md:py-12">
      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
            Help Desk
          </p>
          <h1 className="mt-3 max-w-3xl text-[42px] font-black uppercase leading-none text-white md:text-[64px]">
            Get support without losing context
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] font-medium leading-7 text-[rgb(170,170,170)]">
            Send account, billing, chat, and generation issues to the beta team with
            a reference number you can keep for follow-up.
          </p>

          <div className="mt-8 grid gap-3 md:grid-cols-3" data-testid="helpdesk-support-links">
            <SupportLink
              href="/profile"
              icon={<LifeBuoy className="h-5 w-5" />}
              label="Account & billing"
            />
            <SupportLink
              href="/safety/contact"
              icon={<MessageCircle className="h-5 w-5" />}
              label="Trust contact"
            />
            <SupportLink
              href="/terms"
              icon={<Scale className="h-5 w-5" />}
              label="Policies"
            />
          </div>
        </div>

        <form
          className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5"
          data-testid="helpdesk-form"
          onSubmit={submitRequest}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                Support request
              </p>
              <h2 className="mt-2 text-[24px] font-black uppercase leading-7 text-white">
                Submit an issue
              </h2>
            </div>
            <Send className="h-5 w-5 text-[rgb(253,95,194)]" />
          </div>

          <label className="mt-5 block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
            Category
            <select
              className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[14px] font-semibold text-white outline-none"
              name="category"
              onChange={(event) =>
                setSupportDraftField("category", event.target.value as SupportCategory)
              }
              value={category}
            >
              {categories.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-4 block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
            Subject
            <input
              className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[14px] font-semibold text-white outline-none placeholder:text-[rgb(114,113,112)]"
              maxLength={120}
              name="subject"
              onChange={(event) => setSupportDraftField("subject", event.target.value)}
              placeholder="Generation job stuck"
              value={subject}
            />
          </label>

          <label className="mt-4 block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
            Details
            <textarea
              className="mt-2 min-h-32 w-full resize-y rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[14px] font-medium leading-6 text-white outline-none placeholder:text-[rgb(114,113,112)]"
              maxLength={2000}
              name="description"
              onChange={(event) => setSupportDraftField("description", event.target.value)}
              placeholder="What happened, what you expected, and the page or workflow involved."
              value={description}
            />
          </label>

          <label className="mt-4 flex items-start gap-3 rounded-[10px] border border-white/10 bg-[rgb(28,28,28)] p-3 text-[13px] font-medium leading-5 text-[rgb(220,220,220)]">
            <input
              checked={diagnosticConsent}
              className="mt-1 h-4 w-4 accent-[rgb(253,95,194)]"
              name="diagnosticConsent"
              onChange={(event) => setSupportDraftField("diagnosticConsent", event.target.checked)}
              type="checkbox"
            />
            Attach account and workflow diagnostics to this request.
          </label>

          <button
            className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-black text-[rgb(13,13,13)] transition hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/40"
            disabled={!canSubmit}
            type="submit"
          >
            {submitting ? "Submitting..." : "Submit request"}
            <Send className="h-4 w-4" />
          </button>

          {status && (
            <p
              aria-live="polite"
              className="mt-4 rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[13px] font-semibold text-white"
              data-testid="helpdesk-status"
              role="status"
            >
              {ticketId && <CheckCircle2 className="mr-2 inline h-4 w-4 text-[rgb(96,220,154)]" />}
              {status}
            </p>
          )}
        </form>
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]" id="appeals">
        <div className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                Appeals
              </p>
              <h2 className="mt-2 text-[24px] font-black uppercase leading-7 text-white">
                Ask for another review
              </h2>
            </div>
            <Scale className="h-5 w-5 text-[rgb(253,95,194)]" />
          </div>

          <form className="mt-5 grid gap-4" data-testid="appeal-form" onSubmit={submitAppeal}>
            <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
              Target type
              <select
                className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[14px] font-semibold text-white outline-none"
                name="appealTargetType"
                onChange={(event) =>
                  setAppealDraftField("targetType", event.target.value as AppealTargetType)
                }
                value={appealTargetType}
              >
                {appealTargetTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
              Target ID or link
              <input
                className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[14px] font-semibold text-white outline-none placeholder:text-[rgb(114,113,112)]"
                maxLength={300}
                name="appealTargetId"
                onChange={(event) => setAppealDraftField("targetId", event.target.value)}
                placeholder="character-id or /characters/example"
                value={appealTargetId}
              />
            </label>

            <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
              Decision ID
              <input
                className="mt-2 h-11 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[14px] font-semibold text-white outline-none placeholder:text-[rgb(114,113,112)]"
                maxLength={160}
                name="appealDecisionId"
                onChange={(event) => setAppealDraftField("decisionId", event.target.value)}
                placeholder="Optional"
                value={appealDecisionId}
              />
            </label>

            <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
              Appeal details
              <textarea
                className="mt-2 min-h-28 w-full resize-y rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[14px] font-medium leading-6 text-white outline-none placeholder:text-[rgb(114,113,112)]"
                maxLength={4000}
                name="appealText"
                onChange={(event) => setAppealDraftField("text", event.target.value)}
                placeholder="What should be reviewed again?"
                value={appealText}
              />
            </label>

            <button
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[rgb(253,95,194)] px-5 text-[14px] font-black text-white transition hover:bg-[rgb(220,64,170)] disabled:cursor-not-allowed disabled:bg-[rgb(94,50,78)]"
              disabled={!canSubmitAppeal}
              type="submit"
            >
              {appealSubmitting ? "Submitting..." : "Submit appeal"}
              <Scale className="h-4 w-4" />
            </button>
          </form>

          {appealStatus && (
            <p
              aria-live="polite"
              className="mt-4 rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[13px] font-semibold text-white"
              data-testid="appeal-status"
              role="status"
            >
              {appealStatus}
            </p>
          )}
        </div>

        <div className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5">
          <Scale className="h-5 w-5 text-[rgb(253,95,194)]" />
          <h2 className="mt-4 text-[22px] font-black uppercase leading-7 text-white">
            Track reports and appeals
          </h2>
          <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
            Use a target ID from a character, media item, feed item, chat message, user profile,
            or review notice. Submitted appeals appear in the admin moderation queue.
          </p>
          <div className="mt-5 grid gap-2 text-[13px] font-semibold text-white">
            <Link className="rounded-[10px] bg-[rgb(36,36,36)] px-3 py-3 hover:bg-[rgb(53,53,54)]" href="/terms">
              Terms and policy index
            </Link>
            <Link className="rounded-[10px] bg-[rgb(36,36,36)] px-3 py-3 hover:bg-[rgb(53,53,54)]" href="/safety/moderation/appeals">
              Appeal process
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div>
          <h2 className="text-[24px] font-black uppercase leading-7 text-white">
            FAQ
          </h2>
          <div className="mt-4 grid gap-3">
            {faqs.map((item) => (
              <article
                className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5"
                key={item.question}
              >
                <h3 className="text-[17px] font-black leading-6 text-white">
                  {item.question}
                </h3>
                <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                  {item.answer}
                </p>
              </article>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-[24px] font-black uppercase leading-7 text-white">
              Bugs, features, changelog
            </h2>
            <Link
              className="rounded-full bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-black uppercase text-white hover:bg-[rgb(53,53,54)]"
              href="/upgrade"
            >
              Premium
            </Link>
          </div>
          <div className="mt-4 grid gap-3">
            {roadmapItems.map((item) => (
              <article
                className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5"
                key={item.title}
              >
                <item.icon className="h-5 w-5 text-[rgb(253,95,194)]" />
                <h3 className="mt-4 text-[18px] font-black uppercase leading-6 text-white">
                  {item.title}
                </h3>
                <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                  {item.copy}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-4 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                  Roadmap voting
                </p>
                <h3 className="mt-2 text-[20px] font-black uppercase leading-6 text-white">
                  Vote on what should ship next
                </h3>
              </div>
              {feedbackLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-[rgb(170,170,170)]" />
              ) : (
                <button
                  aria-label="Refresh roadmap items"
                  className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-[rgb(36,36,36)] text-white transition hover:bg-[rgb(53,53,54)]"
                  data-testid="feedback-list-refresh"
                  onClick={() => void loadFeedbackItems()}
                  type="button"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              )}
            </div>

            <form className="mt-5 grid gap-3" data-testid="feedback-form" onSubmit={submitFeedbackItem}>
              <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
                Feedback type
                <select
                  className="mt-2 h-10 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none"
                  name="feedbackCategory"
                  onChange={(event) =>
                    setFeedbackDraftField("category", event.target.value as FeedbackCategory)
                  }
                  value={feedbackCategory}
                >
                  {feedbackCategories.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
                Feature title
                <input
                  className="mt-2 h-10 w-full rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 text-[13px] font-semibold text-white outline-none placeholder:text-[rgb(114,113,112)]"
                  maxLength={120}
                  name="feedbackTitle"
                  onChange={(event) => setFeedbackDraftField("title", event.target.value)}
                  placeholder="Queue priority controls"
                  value={feedbackTitle}
                />
              </label>
              <label className="block text-[12px] font-bold uppercase leading-4 text-[rgb(170,170,170)]">
                Feature details
                <textarea
                  className="mt-2 min-h-24 w-full resize-y rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[13px] font-medium leading-5 text-white outline-none placeholder:text-[rgb(114,113,112)]"
                  maxLength={600}
                  name="feedbackDescription"
                  onChange={(event) => setFeedbackDraftField("description", event.target.value)}
                  placeholder="What problem would this solve, and where should it appear?"
                  value={feedbackDescription}
                />
              </label>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(253,95,194)] px-4 text-[13px] font-black text-white transition hover:bg-[rgb(220,64,170)] disabled:cursor-not-allowed disabled:bg-[rgb(94,50,78)]"
                disabled={!canSubmitFeedback}
                type="submit"
              >
                {feedbackSubmitting ? "Submitting..." : "Submit idea"}
                <Plus className="h-4 w-4" />
              </button>
            </form>

            {feedbackStatus && (
              <p
                aria-live="polite"
                className="mt-4 rounded-[10px] border border-white/10 bg-[rgb(36,36,36)] px-3 py-3 text-[13px] font-semibold text-white"
                data-testid="feedback-status"
                role="status"
              >
                {feedbackStatus}
              </p>
            )}

            <div className="mt-5 grid gap-3" data-testid="feedback-items">
              {feedbackLoading ? (
                <p
                  aria-live="polite"
                  className="rounded-[10px] border border-white/10 bg-[rgb(28,28,28)] p-4 text-[13px] font-semibold text-[rgb(170,170,170)]"
                  data-testid="feedback-list-status"
                  role="status"
                >
                  Loading roadmap items...
                </p>
              ) : null}
              {!feedbackLoading && feedbackLoadError ? (
                <div
                  aria-live="assertive"
                  className="rounded-[10px] border border-white/10 bg-[rgb(28,28,28)] p-4"
                  data-testid="feedback-list-status"
                  role="alert"
                >
                  <p className="text-[13px] font-semibold text-white">{feedbackLoadError}</p>
                  <button
                    className="mt-3 inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                    onClick={() => void loadFeedbackItems()}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {!feedbackLoading && !feedbackLoadError ? feedbackItems.map((item) => (
                <article
                  className="rounded-[10px] border border-white/10 bg-[rgb(28,28,28)] p-4"
                  key={item.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase text-[rgb(253,95,194)]">
                        {item.category} · {feedbackStatusLabel(item.status)}
                      </p>
                      <h4 className="mt-2 text-[16px] font-black leading-5 text-white">
                        {item.title}
                      </h4>
                    </div>
                    <button
                      aria-pressed={item.userVoted}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-[rgb(36,36,36)] px-3 text-[12px] font-black text-white transition hover:bg-[rgb(53,53,54)] disabled:cursor-wait disabled:opacity-70"
                      disabled={feedbackVotingId === item.id}
                      onClick={() => void toggleFeedbackVote(item)}
                      type="button"
                    >
                      <ThumbsUp className="h-4 w-4" />
                      <span>{item.userVoted ? "Voted" : "Vote"}</span>
                      <span className="font-mono">{item.voteCount}</span>
                      <span className="sr-only">for {item.title}</span>
                    </button>
                  </div>
                  <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                    {item.description}
                  </p>
                </article>
              )) : null}
              {!feedbackLoading && !feedbackLoadError && feedbackItems.length === 0 && (
                <p
                  aria-live="polite"
                  className="rounded-[10px] border border-white/10 bg-[rgb(28,28,28)] p-4 text-[13px] font-semibold text-[rgb(170,170,170)]"
                  data-testid="feedback-list-status"
                  role="status"
                >
                  No roadmap items yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SupportLink({
  external,
  href,
  icon,
  label,
}: Readonly<{
  external?: boolean;
  href: string;
  icon: ReactNode;
  label: string;
}>) {
  const TrailingIcon = external ? ExternalLink : ArrowRight;

  return (
    <Link
      className="flex min-h-20 items-center justify-between gap-3 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-4 text-[14px] font-black text-white hover:bg-[rgb(36,36,36)]"
      data-link-kind={external ? "external" : "internal"}
      href={href}
      rel={external ? "noopener noreferrer" : undefined}
      target={external ? "_blank" : undefined}
    >
      <span className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[rgb(36,36,36)] text-[rgb(253,95,194)]">
          {icon}
        </span>
        {label}
      </span>
      <TrailingIcon aria-hidden="true" className="h-4 w-4 text-[rgb(170,170,170)]" />
    </Link>
  );
}

const HELP_DESK_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
type HelpDeskResumeKind = "support" | "feedback" | "appeal" | "vote";

function scopedHelpDeskStorageKey(base: string, viewerScope: string) {
  return `${base}:${viewerScope}`;
}

function readScopedHelpDeskValue(base: string, viewerScope: string) {
  try {
    const key = scopedHelpDeskStorageKey(base, viewerScope);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as unknown;
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    const record = envelope as Record<string, unknown>;
    if (
      record.ownerScope !== viewerScope ||
      typeof record.expiresAt !== "number" ||
      record.expiresAt <= Date.now()
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return JSON.stringify(record.value);
  } catch {
    return null;
  }
}

function writeScopedHelpDeskValue(
  base: string,
  viewerScope: string,
  value: unknown,
) {
  try {
    window.localStorage.setItem(
      scopedHelpDeskStorageKey(base, viewerScope),
      JSON.stringify({
        ownerScope: viewerScope,
        expiresAt: Date.now() + HELP_DESK_DRAFT_TTL_MS,
        value,
      }),
    );
    return true;
  } catch {
    // Storage is an optional resume aid; form submission remains authoritative.
    return false;
  }
}

function clearScopedHelpDeskValue(base: string, viewerScope: string) {
  try {
    window.localStorage.removeItem(
      scopedHelpDeskStorageKey(base, viewerScope),
    );
  } catch {
    // Ignore unavailable local storage.
  }
}

function loadSupportDraft(viewerScope: string): SupportDraft | null {
  return parseSupportDraft(
    readScopedHelpDeskValue(SUPPORT_DRAFT_STORAGE_KEY, viewerScope),
  );
}

function saveSupportDraft(viewerScope: string, draft: SupportDraft) {
  return writeScopedHelpDeskValue(
    SUPPORT_DRAFT_STORAGE_KEY,
    viewerScope,
    draft,
  );
}

function clearSupportDraft(viewerScope: string) {
  clearScopedHelpDeskValue(SUPPORT_DRAFT_STORAGE_KEY, viewerScope);
}

function loadFeedbackDraft(viewerScope: string): FeedbackDraft | null {
  return parseFeedbackDraft(
    readScopedHelpDeskValue(FEEDBACK_DRAFT_STORAGE_KEY, viewerScope),
  );
}

function saveFeedbackDraft(viewerScope: string, draft: FeedbackDraft) {
  return writeScopedHelpDeskValue(
    FEEDBACK_DRAFT_STORAGE_KEY,
    viewerScope,
    draft,
  );
}

function clearFeedbackDraft(viewerScope: string) {
  clearScopedHelpDeskValue(FEEDBACK_DRAFT_STORAGE_KEY, viewerScope);
}

function loadAppealDraft(viewerScope: string): AppealDraft | null {
  return parseAppealDraft(
    readScopedHelpDeskValue(APPEAL_DRAFT_STORAGE_KEY, viewerScope),
  );
}

function saveAppealDraft(viewerScope: string, draft: AppealDraft) {
  return writeScopedHelpDeskValue(
    APPEAL_DRAFT_STORAGE_KEY,
    viewerScope,
    draft,
  );
}

function clearAppealDraft(viewerScope: string) {
  clearScopedHelpDeskValue(APPEAL_DRAFT_STORAGE_KEY, viewerScope);
}

function helpDeskAuthReturnTarget(
  sourceScope: string,
  kind: HelpDeskResumeKind,
  value: unknown,
) {
  return (
    stashDraftTransfer("helpdesk", {
      payload: { kind, value },
      sourceScope,
    }) ?? draftTransferPath("helpdesk")
  );
}

export function shouldClearTransferredHelpDeskDraft(input: {
  saved: boolean;
  sourceScope: string;
  targetScope: string;
}) {
  return input.saved && input.sourceScope !== input.targetScope;
}

function consumeHelpDeskResume(targetScope: string): {
  kind: HelpDeskResumeKind;
  sourceScope: string;
  value: unknown;
} | null {
  const claimed = claimDraftTransfer("helpdesk", { targetScope });
  if (!claimed || !isRecord(claimed.payload)) return null;
  const { kind, value } = claimed.payload;
  if (!isHelpDeskResumeKind(kind)) return null;
  return { kind, sourceScope: claimed.sourceScope, value };
}

function isHelpDeskResumeKind(value: unknown): value is HelpDeskResumeKind {
  return ["support", "feedback", "appeal", "vote"].includes(String(value));
}

function parseSupportDraft(raw: string | null): SupportDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const subject = typeof record.subject === "string" ? record.subject.slice(0, 120) : "";
    const description =
      typeof record.description === "string" ? record.description.slice(0, 2000) : "";
    if (!subject && !description) return null;

    return {
      category: isSupportCategory(record.category)
        ? record.category
        : INITIAL_SUPPORT_DRAFT.category,
      subject,
      description,
      diagnosticConsent:
        typeof record.diagnosticConsent === "boolean"
          ? record.diagnosticConsent
          : INITIAL_SUPPORT_DRAFT.diagnosticConsent,
    };
  } catch {
    return null;
  }
}

function parseFeedbackDraft(raw: string | null): FeedbackDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.slice(0, 120) : "";
    const description =
      typeof record.description === "string" ? record.description.slice(0, 600) : "";
    if (!title && !description) return null;

    return {
      category: isFeedbackCategory(record.category)
        ? record.category
        : INITIAL_FEEDBACK_DRAFT.category,
      title,
      description,
    };
  } catch {
    return null;
  }
}

function parsePendingFeedbackVote(raw: string | null): PendingFeedbackVote | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const itemId = typeof record.itemId === "string" ? record.itemId.slice(0, 160) : "";
    const title = typeof record.title === "string" ? record.title.slice(0, 120) : "";
    const action = record.action === "unvote" ? "unvote" : "vote";
    if (!itemId) return null;

    return { itemId, action, title };
  } catch {
    return null;
  }
}

function parseAppealDraft(raw: string | null): AppealDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const targetId = typeof record.targetId === "string" ? record.targetId.slice(0, 300) : "";
    const decisionId =
      typeof record.decisionId === "string" ? record.decisionId.slice(0, 160) : "";
    const text = typeof record.text === "string" ? record.text.slice(0, 4000) : "";
    if (!targetId && !decisionId && !text) return null;

    return {
      targetType: isAppealTargetType(record.targetType)
        ? record.targetType
        : INITIAL_APPEAL_DRAFT.targetType,
      targetId,
      decisionId,
      text,
    };
  } catch {
    return null;
  }
}

function appealDraftFromSearch(search: string): AppealDraft | null {
  const params = new URLSearchParams(search);
  if (
    !params.has("appealTargetType") &&
    !params.has("appealTargetId") &&
    !params.has("appealDecisionId") &&
    !params.has("appealText")
  ) {
    return null;
  }

  const targetId = searchParamValue(params, "appealTargetId", 300);
  const decisionId = searchParamValue(params, "appealDecisionId", 160);
  const text = searchParamValue(params, "appealText", 4000);
  if (!targetId && !decisionId && !text) return null;

  const targetTypeParam = params.get("appealTargetType");
  return {
    targetType: isAppealTargetType(targetTypeParam)
      ? targetTypeParam
      : INITIAL_APPEAL_DRAFT.targetType,
    targetId,
    decisionId,
    text,
  };
}

function searchParamValue(params: URLSearchParams, key: string, maxLength: number) {
  return (params.get(key) ?? "").trim().slice(0, maxLength);
}

function isSupportCategory(value: unknown): value is SupportCategory {
  return isCatalogMember(SUPPORT_REQUEST_CATEGORIES, value);
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return isCatalogMember(PRODUCT_FEEDBACK_CATEGORIES, value);
}

function isAppealTargetType(value: unknown): value is AppealTargetType {
  return isCatalogMember(APPEAL_TARGET_TYPES, value);
}

function helpdeskErrorMessage(status: number, fallback?: string) {
  if (status === 401) return "Sign in to submit a tracked support request.";
  if (status === 403) return "Accept the age gate before submitting support.";
  return fallback ?? "Support request failed. Try again.";
}

function feedbackErrorMessage(status: number, fallback?: string) {
  if (status === 401) return "Sign in to submit ideas and vote.";
  if (status === 403) return "Accept the age gate before voting.";
  return fallback ?? "Feature voting failed. Try again.";
}

function apiErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

function appealErrorMessage(status: number, fallback?: string) {
  if (status === 401) return "Sign in to submit an appeal.";
  if (status === 403) return "Accept the age gate before submitting an appeal.";
  return fallback ?? "Appeal failed. Try again.";
}

function upsertFeedbackItem(items: FeedbackItem[], next: FeedbackItem) {
  const replaced = items.map((item) => (item.id === next.id ? next : item));
  if (replaced.some((item) => item.id === next.id)) return sortFeedbackItems(replaced);
  return sortFeedbackItems([next, ...items]);
}

function sortFeedbackItems(items: FeedbackItem[]) {
  return [...items].sort((a, b) => b.voteCount - a.voteCount || a.title.localeCompare(b.title));
}

const feedbackStatusLabels: Record<ProductFeedbackStatus, string> = {
  under_review: "under review",
  planned: "planned",
  shipped: "shipped",
};

// `under_review` is the server default and is now matched explicitly; unknown
// values still fall back to it rather than showing a raw enum member.
function feedbackStatusLabel(status: string) {
  return isCatalogMember(PRODUCT_FEEDBACK_STATUSES, status)
    ? feedbackStatusLabels[status]
    : feedbackStatusLabels.under_review;
}
