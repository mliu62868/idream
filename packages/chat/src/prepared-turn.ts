// SPEC: CompanionTurn is the single generation-facing seam. It owns pinned Soul,
// Scene, memory, transcript, prompt order, tool exposure, budget,
// and trace assembly; the worker must not rebuild any of those independently.
import { createHash } from "node:crypto";
import {
  COMPANION_PRODUCT_PROMPT_VERSION,
  type ChatToolDefinition,
} from "@idream/shared";
import { EDIT_LAST_IMAGE_TOOL } from "@idream/shared/chat/image-action";
import { imageIntentForUserRequest, resolveImageIntent, type ImageIntentDecision } from "./image-intent.js";
import { logger } from "./logger.js";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
import { buildContext, type BuiltContext } from "./context.js";
import { buildCompanionSystemPrompt, buildTurnPreferencesBlock, buildTurnStateBlock, describeRequestedLength, describeUserLanguage } from "./prompt.js";
import { registryChatTools } from "./agent-tools.js";
import { dropOldestReplayExchange, estimateModelRequestInputTokens, formatModelRequestInput } from "./agent-runtime/model-request-format.js";
import {
  preparedTurnSchema,
  type PreparedTurnInput,
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
  const currentUser = context.recentMessages.find((message) => message.id === input.snapshot.userMessageId);
  const imageIntent = await resolveImageIntent({
    userText: currentUser?.content ?? "",
    hasRecentImageContext: context.hasRecentImageContext,
    imageToolEnabled: context.policy.imageToolEnabled && context.policy.modelProfile.supportsTools,
    onJudgeUnavailable: (reason: string) => logger.warn({ event: "image_intent_judge" }, reason),
  });
  return compilePreparedTurn(context, input.snapshot.userMessageId, new Date(), imageIntent);
}

/** Compile a pure, pinned generation snapshot from an already-authoritative context. */
export function compilePreparedTurn(
  context: BuiltContext,
  currentUserMessageId: string,
  now: Date = new Date(),
  imageIntent?: ImageIntentDecision,
): PreparedTurn {
  const fitted = fitPreparedTurnBudget(context, currentUserMessageId, now, imageIntent);
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
    omittedMessages: (context.replayMessages ?? context.recentMessages)
      .filter(message => message.id !== currentUserMessageId && !fitted.messages.some(retained => retained.id === message.id))
      .map(message => ({
        id: message.id, sourceKind: "replay", role: message.role, content: message.content,
        ...(message.speaker && message.role === "assistant" && message.speaker.characterId !== context.persona.characterId
          ? { speaker: message.speaker } : {}),
      })),
    tools: fitted.tools,
    imageRequest: fitted.imageRequest,
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

function buildPreparedMessages(
  context: BuiltContext,
  currentUserMessageId: string,
  turnState: string,
  turnPreferences: string,
): PreparedTurnInput["messages"] {
  const systemContent = buildCompanionSystemPrompt(context);
  const messages: PreparedTurnInput["messages"] = [{
    id: `system:${sha256(systemContent)}`,
    sourceKind: "plugin",
    role: "system",
    content: systemContent,
  }];
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
  resolvedImageIntent?: ImageIntentDecision,
): {
  context: BuiltContext;
  messages: PreparedTurnInput["messages"];
  tools: ChatToolDefinition[];
  imageRequest: PreparedTurnInput["imageRequest"];
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
  // Capability controls availability; the Agent decides whether this request
  // needs an image. An edit additionally needs a Main-owned delivered image.
  const tools = fitted.policy.imageToolEnabled && fitted.policy.modelProfile.supportsTools
    ? registryChatTools().filter(tool => tool.name !== EDIT_LAST_IMAGE_TOOL || fitted.hasRecentImageContext)
    : [];
  // Recovery and pure callers re-derive the deterministic decision; only
  // prepareCompanionTurn also consults the small judge.
  const imageIntent = resolvedImageIntent ?? imageIntentForUserRequest({
    userText: currentUser.content,
    hasRecentImageContext: fitted.hasRecentImageContext,
  });
  const imageRequest = imageIntent.kind !== "none" && tools.some((tool) => tool.name === imageIntent.action.name)
    ? { ...imageIntent.action, userText: currentUser.content.slice(0, 4_000) }
    : null;
  const maxInputTokens = Math.max(1, Math.ceil(fitted.policy.maxContextChars / 4));
  const dropped = new Set(fitted.dropped);
  const replayMessageIds = new Set(fitted.recentMessages.filter(message => message.id !== currentUserMessageId).map(message => message.id));
  const language = describeUserLanguage(currentUser.content);
  const length = describeRequestedLength(currentUser.content);
  // Rebuilt on every budget pass so it only quotes dialogue that is still retained.
  const turnState = () => [
    buildTurnStateBlock(fitted, now),
    ...(language ? [`- ${language}`] : []),
    ...(length ? [`- ${length}`] : []),
    ...recentOpeningsLines(fitted, currentUserMessageId),
    // INTENT: measured 2026-10-08, the Agent alone kept ~half of clear photo
    // requests and otherwise promised one in words. The photo now goes out with
    // this reply either way, so the words must match it.
    ...(imageRequest?.name === "generate_image_async"
      ? ["- Their message asks you for a photo now, and it is sent with this reply: call generate_image_async with the scene and answer as you send it. Never say you cannot send photos."]
      : imageRequest?.name === "edit_last_image"
        ? ["- Their message asks you to change the photo you just sent, and the change is sent with this reply: call edit_last_image and answer as you send it."]
        : []),
  ].join("\n");
  const turnPreferences = buildTurnPreferencesBlock(fitted);
  const calculate = () => {
    const messages = buildPreparedMessages(fitted, currentUserMessageId, turnState(), turnPreferences);
    const usedInputTokens = estimateModelRequestInputTokens(formatModelRequestInput({ messages, tools }));
    return { messages, usedInputTokens };
  };

  // SPEC: leave room for what the runtime adds after this snapshot — DSH tool
  // guidance (~370 tokens), igrep tool schemas (~825), recall notes (~700),
  // measured on a real 2026-10-08 request — plus DSH's compaction headroom (512),
  // so a normal request stays under the compaction trigger.
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
    tools,
    imageRequest,
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
