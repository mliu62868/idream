// SPEC: validate the Agent terminal text and execution receipts; tool choice belongs to the Agent.
import { hasUnexecutedMemorySearchPayload } from "@idream/shared/chat/companion-runtime";
import { imageReplyMatchesUserScript } from "@idream/shared/chat/image-action";
import type {
  CompanionModelRequestEvidence,
  CompanionTerminalCandidate,
} from "./contracts";

export type TerminalValidationCode =
  | "unexecuted_tool_payload"
  | "image_reply_language_mismatch"
  | "image_reply_exposed_process";

export interface TerminalCandidateFacts {
  attemptId: string;
  /** 组装好的终态 assistant 正文；DSH 没给出终态消息时为 undefined。 */
  assistantContent: string | undefined;
  /** DSH finish chunk 的 reason.kind；没有 finish chunk 时为 undefined。 */
  finishReasonKind: string | undefined;
  /** 本轮用户原话，用于图片回复的书写体系判定。 */
  currentUserText: string;
  /** PreparedTurn 暴露的工具，用于识别「模型把工具调用当正文吐出来」。 */
  tools: readonly { name: string }[];
  toolCalls: number;
  reservations: CompanionTerminalCandidate["tools"];
  profile: { provider: string; model: string };
  usage: CompanionTerminalCandidate["usage"];
  steps: number;
  completedAt: string;
  modelRequests?: readonly CompanionModelRequestEvidence[];
  attribution?: CompanionTerminalCandidate["attribution"];
}

export type TerminalCandidateDecision =
  | { accepted: true; candidate: CompanionTerminalCandidate }
  | { accepted: false; code?: TerminalValidationCode; message: string };

// SPEC: 图片回复使用角色口吻。提到提示词 / 工具调用 / 生图流程 / 翻译，
// 说明模型在向用户暴露执行过程，这一轮不能交付。
const EXPOSED_PROCESS =
  /\b(?:prompt|tool call|image generation process|translation)\b|(?:提示词|工具调用|生图流程|翻译)/iu;

export function evaluateTerminalCandidate(
  facts: TerminalCandidateFacts,
): TerminalCandidateDecision {
  if (facts.assistantContent === undefined || facts.finishReasonKind === undefined) {
    return { accepted: false, message: "turn stopped without a terminal assistant candidate" };
  }
  const content = facts.assistantContent;
  if (!content) {
    return { accepted: false, message: "terminal assistant candidate is empty" };
  }
  if (
    hasUnexecutedMemorySearchPayload(content) ||
    isUnexecutedImageToolPayload(content, facts.tools)
  ) {
    return {
      accepted: false,
      code: "unexecuted_tool_payload",
      message: "terminal assistant candidate contained an unexecuted tool payload",
    };
  }
  if (facts.toolCalls > 0) {
    if (!imageReplyMatchesUserScript(facts.currentUserText, content)) {
      return {
        accepted: false,
        code: "image_reply_language_mismatch",
        message: "image reply did not match the user's writing system",
      };
    }
    if (EXPOSED_PROCESS.test(content)) {
      return {
        accepted: false,
        code: "image_reply_exposed_process",
        message: "image reply exposed the generation process",
      };
    }
  }
  if (facts.finishReasonKind !== "stop" && facts.finishReasonKind !== "max-tokens") {
    return {
      accepted: false,
      message: `non-terminal finish reason ${facts.finishReasonKind}`,
    };
  }
  return {
    accepted: true,
    candidate: {
      attemptId: facts.attemptId,
      content,
      finishReason: facts.finishReasonKind === "max-tokens" ? "length" : "stop",
      provider: facts.profile.provider,
      model: facts.profile.model,
      usage: facts.usage === null ? null : { ...facts.usage },
      execution: { steps: facts.steps, toolCalls: facts.toolCalls },
      tools: facts.reservations,
      completedAt: facts.completedAt,
      ...(facts.modelRequests?.length ? { modelRequests: [...facts.modelRequests] } : {}),
      ...(facts.attribution ? { attribution: facts.attribution } : {}),
    },
  };
}

export function isUnexecutedImageToolPayload(
  content: string,
  tools: readonly { name: string }[],
): boolean {
  if (!tools.some((tool) =>
    tool.name === "generate_image_async" || tool.name === "edit_last_image"
  )) return false;
  let candidate = content.trim();
  if (/(?:^|\n)\s*(?:\[image\s*:[^\]\n]+\]|【图片\s*[：:][^】\n]+】)\s*(?:$|\n)/iu.test(candidate)) {
    return true;
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(candidate);
  if (fenced) candidate = fenced[1] ?? "";
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const row = parsed as Record<string, unknown>;
    // An image field is ordinary data. Only an explicit tool name identifies
    // an unexecuted image call; exposing tools cannot invalidate normal JSON.
    const nested = row.function && typeof row.function === "object" && !Array.isArray(row.function)
      ? row.function as Record<string, unknown>
      : null;
    const name = typeof row.name === "string"
      ? row.name
      : typeof row.tool === "string"
        ? row.tool
        : typeof nested?.name === "string"
          ? nested.name
          : "";
    return name === "generate_image_async" || name === "edit_last_image";
  } catch {
    return false;
  }
}
