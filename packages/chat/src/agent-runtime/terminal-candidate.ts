// SPEC: 决定「这一轮的终态候选能不能交给 Main」。输入全是纯数据，输出要么是
// 一个 CompanionTerminalCandidate，要么是一条拒绝理由（其中五条带 validationCode）。
// INTENT: 这段判断过去长在 engine.ts 的 `agent/turn-stopping` hook 闭包里 —— 纯计算
//   却必须起真 cordis Context + DSH agent 才能触发一次，于是测试反过来从 public
//   options 注入假 igrep/假 adapter 去摇它。把它抽出来之后，五个 validationCode ×
//   requiredAction 有无都能表驱动直测，engine 只负责把事实喂进来、把副作用发出去。
// INVARIANT: 本模块不读时钟、不碰文件、不发事件。completedAt 由调用方传入。
import { hasUnexecutedMemorySearchPayload } from "@idream/shared/chat/companion-runtime";
import { requiredImageReplyMatchesUserScript } from "@idream/shared/chat/image-action";
import type {
  CompanionModelRequestEvidence,
  CompanionTerminalCandidate,
} from "./contracts";

export type TerminalValidationCode =
  | "unexecuted_tool_payload"
  | "required_image_reply_language_mismatch"
  | "required_image_reply_exposed_process"
  | "required_image_tool_missing"
  | "required_image_tool_mismatch";

export interface TerminalCandidateFacts {
  attemptId: string;
  /** 组装好的终态 assistant 正文；DSH 没给出终态消息时为 undefined。 */
  assistantContent: string | undefined;
  /** DSH finish chunk 的 reason.kind；没有 finish chunk 时为 undefined。 */
  finishReasonKind: string | undefined;
  /** 本轮用户原话，用于必需图片回复的书写体系判定。 */
  currentUserText: string;
  requiredAction: { name: string } | null;
  /** PreparedTurn 暴露的工具，用于识别「模型把工具调用当正文吐出来」。 */
  tools: readonly { name: string }[];
  toolCalls: number;
  reservations: CompanionTerminalCandidate["tools"];
  profile: { provider: string; model: string };
  usage: CompanionTerminalCandidate["usage"];
  steps: number;
  completedAt: string;
  modelRequests?: readonly CompanionModelRequestEvidence[];
  acknowledgement?: CompanionTerminalCandidate["acknowledgement"];
  attribution?: CompanionTerminalCandidate["attribution"];
}

export type TerminalCandidateDecision =
  | { accepted: true; candidate: CompanionTerminalCandidate }
  | { accepted: false; code?: TerminalValidationCode; message: string };

// SPEC: 必需图片回复只能是一句人话。提到提示词 / 工具调用 / 生图流程 / 翻译，
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
  const requiredAction = facts.requiredAction;
  if (requiredAction) {
    if (!requiredImageReplyMatchesUserScript(facts.currentUserText, content)) {
      return {
        accepted: false,
        code: "required_image_reply_language_mismatch",
        message: "required image reply did not match the user's writing system",
      };
    }
    if (EXPOSED_PROCESS.test(content)) {
      return {
        accepted: false,
        code: "required_image_reply_exposed_process",
        message: "required image reply exposed the generation process",
      };
    }
    if (facts.toolCalls === 0) {
      return {
        accepted: false,
        code: "required_image_tool_missing",
        message: "required image action ended without a tool call",
      };
    }
    if (facts.toolCalls !== 1 || facts.reservations[0]?.name !== requiredAction.name) {
      return {
        accepted: false,
        code: "required_image_tool_mismatch",
        message: "required image action executed the wrong tool sequence",
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
      usage: { ...facts.usage },
      execution: { steps: facts.steps, toolCalls: facts.toolCalls },
      tools: facts.reservations,
      completedAt: facts.completedAt,
      ...(facts.modelRequests?.length ? { modelRequests: [...facts.modelRequests] } : {}),
      ...(facts.acknowledgement ? { acknowledgement: facts.acknowledgement } : {}),
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
    if (typeof row.image === "string" && row.image.trim()) return true;
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
