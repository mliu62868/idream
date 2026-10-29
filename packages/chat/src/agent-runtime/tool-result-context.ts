import { EDIT_LAST_IMAGE_TOOL, GENERATE_IMAGE_ASYNC_TOOL } from "@idream/shared/chat/image-action";
import type { CompanionToolResult } from "./contracts";

/** Keep Main's receipt intact; only its existing status guides the next reply. */
export function successfulToolResultContent(result: Extract<CompanionToolResult, { outcome: "succeeded" }>) {
  const output = [{ type: "text" as const, text: JSON.stringify(result) }];
  if (result.name !== GENERATE_IMAGE_ASYNC_TOOL && result.name !== EDIT_LAST_IMAGE_TOOL) return output;
  const status = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output.status : undefined;
  const guidance = status === "accepted" || status === "queued"
    ? "The current image request is still processing. No finished image is available yet. Reply only with a brief, present-tense progress acknowledgment, including the opening. Start with the ongoing status; never start with 'Done' or any completion claim. Do not repeat requested edit or scene details while the image is pending: those are requests, not observed results. Earlier assistant claims of completion are not evidence for this request."
    : status === "completed"
      ? "This image receipt confirms delivery only. It contains no observation of the finished image or proof that the requested edit succeeded."
      : null;
  if (guidance) output.push({ type: "text", text: `\n\n${guidance} Do not claim visual correctness or promise unchanged details. Briefly acknowledge the status in Character, without internal technical details.` });
  return output;
}
