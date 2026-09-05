import { createHash } from "node:crypto";
import path from "node:path";

// SPEC: Chat resolves relative file authority exactly once against its own
// runtime cwd; producers and gates must use the same rule.
export function resolveChatFsRoot(root: string, chatWorkingDirectory: string) {
  return path.resolve(chatWorkingDirectory, root);
}

// INVARIANT: cross-service evidence compares the exact effective filesystem
// authority without publishing its host path into a probe report.
export function chatFsRootFingerprint(root: string) {
  if (!path.isAbsolute(root)) {
    throw new Error("Chat FS authority root must be absolute");
  }
  const canonical = path.normalize(root);
  return createHash("sha256")
    .update("idream.chat-fs-root.v1\0")
    .update(canonical)
    .digest("hex");
}
