import { env } from "./env.js";
import {
  purgeCompanionWorkspace,
  type CompanionWorkspacePurgeTarget,
} from "./companion-runtime.js";

/** DSH deletions over-forget the relationship workspace when per-item delete is unavailable. */
export async function purgeRuntimeMemoryIfActive(
  target: CompanionWorkspacePurgeTarget,
): Promise<void> {
  const config = env.COMPANION_RUNTIME_CONFIG;
  if (config.runtime !== "dsh") return;
  await purgeCompanionWorkspace({
    baseUrl: config.sidecarUrl,
    token: config.sidecarToken,
    target,
  });
}
