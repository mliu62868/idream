// SPEC: CompanionTurn is the single generation-facing seam. It owns pinned Soul,
// Scene, memory, transcript, prompt order, tool exposure, budget,
// and trace assembly; the worker must not rebuild any of those independently.
import { createHash } from "node:crypto";
import {
  COMPANION_PRODUCT_PROMPT_VERSION,
  type ChatToolDefinition,
} from "@idream/shared";
import { EDIT_LAST_IMAGE_TOOL, EDIT_LAST_IMAGE_TOOL_DEFINITION, LOCAL_IMAGE_EDIT_TOOL_DEFINITION } from "@idream/shared/chat/image-action";
import { REQUEST_CHARACTER_MEDIA_TOOL, RESEND_SESSION_MEDIA_TOOL, COMPANION_MEDIA_TOOL_DEFINITIONS } from "@idream/shared/chat/media-library";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
import { buildContext, type BuiltContext } from "./context.js";
import { buildTurnPreferencesBlock, buildTurnStateBlock, captureCompanionSystemSource, renderCompanionReplyPrompt } from "./prompt.js";
import { dropOldestReplayExchange, estimateModelRequestInputTokens, formatModelRequestInput } from "./agent-runtime/model-request-format.js";
import type { ReplyCueOptions } from "./reply-cues.js";
import {
  preparedTurnSchema,
  type PreparedReplyPrompt,
  type PreparedTurnInput,
  type PreparedTurnMessage,
} from "./agent-runtime/contracts.js";

export interface PreparedTurn extends PreparedTurnInput {
  /** Main-owned context needed only for deterministic terminal finalization. */
  context: BuiltContext;
}

export interface PrepareCompanionTurnInput {
  snapshot: ChatExecutionSnapshot;
  authority: ChatAuthoritySnapshot;
}

export async function prepareCompanionTurn(
  input: PrepareCompanionTurnInput,
): Promise<PreparedTurn> {
  const context = await buildContext(input);
  return compilePreparedTurn(context, input.snapshot.userMessageId);
}

/**
 * Compile a pure, pinned generation snapshot from an already-authoritative context.
 * `options.replyCues: false` exists for offline evaluation only (see reply-cues.ts);
 * production callers omit it.
 */
export function compilePreparedTurn(
  context: BuiltContext,
  currentUserMessageId: string,
  now: Date = new Date(),
  options: ReplyCueOptions = {},
): PreparedTurn {
  const fitted = fitPreparedTurnBudget(context, currentUserMessageId, now, options);
  const modelProfile = fitted.context.policy.modelProfile;
  const profile: PreparedTurnInput["profile"] = {
    tier: fitted.context.policy.tier,
    adapter: modelProfile.adapter,
    provider: modelProfile.provider,
    baseUrl: modelProfile.baseUrl,
    model: modelProfile.model,
    supportsTools: modelProfile.supportsTools,
    maxOutputTokens: modelProfile.maxOutputTokens,
    ...(fitted.context.experience?.conversationProfile || (fitted.context.experience && fitted.context.experience.responseLength !== "auto") ? {
      answerMaxOutputTokens: Math.min(modelProfile.maxOutputTokens, fitted.context.experience?.conversationProfile?.answerMaxOutputTokens ?? (fitted.context.experience?.responseLength === "short" ? 512 : 2048)),
    } : {}),
    timeout: {
      firstTokenMs: modelProfile.firstTokenTimeoutMs,
      idleMs: modelProfile.idleTimeoutMs,
    },
    sampling: {
      temperature: modelProfile.temperature ?? 0.9,
      topP: modelProfile.topP ?? 0.95,
      repetitionPenalty: modelProfile.repetitionPenalty ?? 1.05,
    },
  };
  const execution = preparedTurnSchema.parse({
    version: 6,
    model: profile.model,
    characterName: fitted.context.persona.name,
    messages: fitted.messages,
    replyPrompt: fitted.replyPrompt,
    omittedMessages: (context.replayMessages ?? context.recentMessages)
      .filter(message => message.id !== currentUserMessageId && !fitted.messages.some(retained => retained.id === message.id))
      .map(message => ({
        id: message.id, sourceKind: "replay", role: message.role, content: message.content,
        ...(message.speaker && message.role === "assistant" && message.speaker.characterId !== context.persona.characterId
          ? { speaker: message.speaker } : {}),
      })),
    tools: fitted.tools,
    ...(context.imageActionMode ? { imageActionMode: context.imageActionMode } : {}),
    ...(context.recoveredMediaAction ? { recoveredMediaAction: context.recoveredMediaAction } : {}),
    profile,
    budget: fitted.budget,
    trace: {
      productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
      systemPromptDigest: sha256(
        fitted.messages.find((message) => message.role === "system")?.content ?? "",
      ),
      characterContentVersionId:
        fitted.context.persona.characterContentVersionId ?? fail("Character content version is required"),
      characterReleaseId: fitted.context.persona.characterReleaseId,
      soulFingerprint: fitted.context.persona.soulFingerprint ?? fail("Soul fingerprint is required"),
      compilerVersion: fitted.context.persona.compilerVersion ?? fail("Soul compiler version is required"),
      sceneVersion: fitted.context.sceneVersion,
      contextRevision: fitted.context.contextRevision.toString(),
    },
  });
  return {
    ...execution,
    context: fitted.context,
  };
}

/** Project verified text excerpts under the current user's original identity. */
export function projectPreparedBody(
  prepared: PreparedTurnInput,
  original: Extract<PreparedTurnMessage, { role: "user" }>,
  independentText: string,
  multipleRequests: boolean,
  options: ReplyCueOptions = {},
) {
  const tools: PreparedTurnInput["tools"] = [];
  const prompt = prepared.replyPrompt && renderCompanionReplyPrompt({
    source: prepared.replyPrompt, characterName: prepared.characterName, tools, userText: independentText,
    multipleRequests, ...(options.replyCues === false ? { replyCues: false } : {}),
  });
  const current = { ...original, content: independentText };
  const messages = prepared.messages.map((message, index) => {
    if (message.id === original.id) return current;
    // Literal probe inputs own their fixed messages. Compiled Turns identify
    // their projected system and state frames independently of their wording.
    if (!prompt) return message;
    if (index === 0) return preparedSystemMessage(prompt.system);
    if (message.id === `state:${original.id}`) return { ...message, content: prompt.state };
    return message;
  });
  return { preparedTurn: { ...prepared, messages, tools }, current };
}

function preparedSystemMessage(content: string): Extract<PreparedTurnMessage, { role: "system" }> {
  return { id: `system:${sha256(content)}`, sourceKind: "plugin", role: "system", content };
}

function buildPreparedMessages(
  context: BuiltContext,
  currentUserMessageId: string,
  systemContent: string,
  turnState: string,
  turnPreferences: string,
): PreparedTurnInput["messages"] {
  const messages: PreparedTurnInput["messages"] = [preparedSystemMessage(systemContent)];
  for (const message of context.recentMessages) {
    const isCurrent = message.id === currentUserMessageId;
    if (isCurrent) {
      if (turnPreferences) messages.push({
        id: `preferences:${currentUserMessageId}`,
        sourceKind: "plugin",
        role: "user",
        content: turnPreferences,
      });
      // The state stays immediately before the current message and is never
      // ingested as user-authored memory.
      messages.push({
        id: `state:${currentUserMessageId}`,
        sourceKind: "plugin",
        role: "user",
        content: turnState,
      });
    }
    messages.push({
      id: message.id,
      sourceKind: isCurrent ? "current_user" : "replay",
      role: message.role,
      // Only another member's line carries its speaker: the request format
      // labels labelled lines "Name: …", and the responding Character's own
      // earlier replies must stay bare so it does not start prefixing itself.
      ...(message.speaker && message.role === "assistant" && message.speaker.characterId !== context.persona.characterId
        ? { speaker: message.speaker }
        : {}),
      content: message.photoSummary
        ? `${message.content}\n[You sent a photo: ${message.photoSummary}]`
        : message.content,
    });
  }
  return messages;
}

/**
 * INVARIANT: the tier budget covers every adapter byte. Degradation order is
 * fixed and observable: drop only the oldest complete transcript exchange.
 */
export function fitPreparedTurnBudget(
  context: BuiltContext,
  currentUserMessageId: string,
  now: Date = new Date(),
  options: ReplyCueOptions = {},
): {
  context: BuiltContext;
  messages: PreparedTurnInput["messages"];
  replyPrompt: PreparedReplyPrompt;
  tools: ChatToolDefinition[];
  budget: PreparedTurn["budget"];
} {
  const fitted: BuiltContext = {
    ...context,
    recentMessages: context.recentMessages.map((message) => ({ ...message })),
    dropped: [...context.dropped],
  };
  const currentUser = fitted.recentMessages.find((message) => message.id === currentUserMessageId);
  if (!currentUser || currentUser.role !== "user") {
    throw new Error("PreparedTurn current user message is missing");
  }
  // Main's publication capability is independent of paid generation. Existing
  // delivered media remains resendable even after a library item is withdrawn.
  // The Agent still interprets the request; no wording classifier selects tools.
  const mediaKinds = fitted.persona.mediaLibraryKinds ?? [];
  const imageActionMode = fitted.imageActionMode ?? "chat";
  const requestKinds = [
    ...(fitted.policy.imageToolEnabled || mediaKinds.includes("image") ? ["image" as const] : []),
    ...(mediaKinds.includes("video") ? ["video" as const] : []),
  ];
  const tools = fitted.policy.modelProfile.supportsTools && !fitted.recoveredMediaAction
    ? COMPANION_MEDIA_TOOL_DEFINITIONS.flatMap(tool => {
        if (tool.name === RESEND_SESSION_MEDIA_TOOL) return fitted.recentMedia?.length ? [tool] : [];
        if (tool.name === EDIT_LAST_IMAGE_TOOL) {
          return fitted.policy.imageToolEnabled && fitted.hasRecentImageContext && imageActionMode !== "library"
            ? [imageActionMode === "paid" ? EDIT_LAST_IMAGE_TOOL_DEFINITION : LOCAL_IMAGE_EDIT_TOOL_DEFINITION]
            : [];
        }
        if (tool.name !== REQUEST_CHARACTER_MEDIA_TOOL || requestKinds.length === 0 || imageActionMode === "library") return [];
        return [{
          ...tool,
          parameters: {
            ...tool.parameters,
            properties: {
              ...(tool.parameters.properties as Record<string, unknown>),
              kind: { type: "string", enum: requestKinds },
            },
          },
        }];
      })
    : [];
  const system = captureCompanionSystemSource(fitted);
  const turnFacts = buildTurnStateBlock(fitted, now);
  const maxInputTokens = Math.max(1, Math.ceil(fitted.policy.maxContextChars / 4));
  const dropped = new Set(fitted.dropped);
  const replayMessageIds = new Set(fitted.recentMessages.filter(message => message.id !== currentUserMessageId).map(message => message.id));
  const turnPreferences = buildTurnPreferencesBlock(fitted);
  const calculate = () => {
    // Only quote replies retained by this budget pass.
    const replyPrompt = { system, turnFacts, recentOpenings: recentOpeningsLines(fitted, currentUserMessageId) };
    const prompt = renderCompanionReplyPrompt({
      source: replyPrompt, characterName: fitted.persona.name, tools, imageActionMode, userText: currentUser.content,
      ...(options.replyCues === false ? { replyCues: false } : {}),
    });
    const messages = buildPreparedMessages(fitted, currentUserMessageId, prompt.system, prompt.state, turnPreferences);
    const usedInputTokens = estimateModelRequestInputTokens(formatModelRequestInput({ messages, tools, respondingCharacterId: fitted.persona.characterId }));
    return { messages, replyPrompt, usedInputTokens };
  };

  // SPEC: leave room for runtime tools, recall notes and compaction headroom.
  // This reserve retains the conservative 2026-10-08 DSH measurements (tool
  // guidance ~370, schemas ~825, notes ~700, headroom 512 tokens); Pi still
  // validates the fully assembled request at the actual provider boundary.
  // INTENT: past that trigger DSH folded the dialogue into a task-handoff digest
  // (its "Goal" was the session's first message) and the companion acted on it:
  // around turn 13 for free readers, replies derailed and took 13–34 s.
  // Trimming whole old exchanges here keeps the dialogue a dialogue.
  const transcriptBudget = Math.max(1, maxInputTokens - RUNTIME_RESERVE_TOKENS);
  let calculated = calculate();
  while (calculated.usedInputTokens > transcriptBudget) {
    // INVARIANT: the transcript is a sequence of user-led exchanges. Dropping a
    // single message can make an old assistant reply look like an unsolicited
    // instruction, so budget pressure removes the whole oldest exchange.
    const retained = dropOldestReplayExchange(fitted.recentMessages, replayMessageIds);
    if (!retained) break;
    fitted.recentMessages = retained;
    dropped.add("transcript");
    calculated = calculate();
  }
  if (calculated.usedInputTokens > maxInputTokens) {
    throw new Error(
      `PreparedTurn fixed context requires ${calculated.usedInputTokens} tokens but tier ${fitted.policy.tier} allows ${maxInputTokens}`,
    );
  }
  fitted.dropped = [...dropped];
  return {
    context: fitted,
    messages: calculated.messages,
    replyPrompt: calculated.replyPrompt,
    tools,
    budget: {
      maxInputTokens,
      usedInputTokens: calculated.usedInputTokens,
      dropped: [...dropped],
    },
  };
}

const RUNTIME_RESERVE_TOKENS = 2_560;

/**
 * SPEC: list how this Character's last few replies opened, so the next one opens
 * differently.
 * INTENT (2026-10-08): in long chats the local model copied its own stock gesture
 * ("I set down the tape gun…") into most replies. Replay of a real session: first
 * sentence reusing a recent 4-gram 26/40 → 3/40 (N=40); the prop anywhere in the
 * reply 12/20 → 1/20 once the wording covers the whole reply, not just its opening.
 * Length and persona slips unchanged. presence/frequency/repetition penalties had
 * no effect on this server.
 */
function recentOpeningsLines(context: BuiltContext, currentUserMessageId: string): string[] {
  const openings = context.recentMessages
    .filter((message) => message.id !== currentUserMessageId && message.role === "assistant" &&
      (!message.speaker || message.speaker.characterId === context.persona.characterId))
    .slice(-4)
    .map((message) => {
      const flat = message.content.replace(/\s+/g, " ").trim();
      const first = flat.match(/^.*?[.!?"](?:\s|$)/)?.[0]?.trim() ?? flat;
      return first.length > 90 ? `${first.slice(0, 89)}…` : first;
    })
    .filter(Boolean);
  if (openings.length < 2) return [];
  return [
    "- Your last replies opened like this; open differently and do not reuse their gestures, props or phrasing anywhere in this reply:",
    ...openings.map((opening) => `  • ${opening}`),
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}
