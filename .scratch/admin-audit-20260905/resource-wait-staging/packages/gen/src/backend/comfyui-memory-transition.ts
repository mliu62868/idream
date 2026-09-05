import { env } from "../env";
import { logger } from "../logger";
import type { ComfyUiRunner } from "./registry";

type RunnerEndpoints = Readonly<Record<ComfyUiRunner, string>>;

type MemoryTransitionOptions = {
  readonly endpoints?: RunnerEndpoints;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 3_000;

function defaultEndpoints(): RunnerEndpoints {
  return {
    image: env.COMFYUI_IMAGE_API_URL,
    video: env.COMFYUI_VIDEO_API_URL,
    "video-h3": env.COMFYUI_H3_API_URL,
  };
}

function normalizeEndpoint(value: string) {
  return value.replace(/\/+$/, "");
}

// SPEC: once the host-wide accelerator lease is held, the selected ComfyUI
// runner keeps its hot cache while every distinct competing runner is asked to
// release model references and its MPS allocator cache before submission.
// INTENT: separate processes isolate plugins and workflow code, but Apple MPS
// still uses one unified-memory pool; retaining an idle image/H3 model while a
// RedGraft job loads creates avoidable compression and swap pressure.
// INVARIANT: transition failure is best-effort and cannot fail a paid attempt —
// an unavailable alternative runner is not evidence that the selected runner
// cannot execute. The selected endpoint is never freed, including when two
// runner names intentionally share one endpoint.
export async function prepareComfyUiRunnerMemory(
  target: ComfyUiRunner,
  options: MemoryTransitionOptions = {},
) {
  const endpoints = options.endpoints ?? defaultEndpoints();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targetEndpoint = normalizeEndpoint(endpoints[target]);
  const competingEndpoints = new Map<string, ComfyUiRunner>();

  for (const runner of ["image", "video", "video-h3"] as const) {
    const endpoint = normalizeEndpoint(endpoints[runner]);
    if (runner !== target && endpoint !== targetEndpoint) {
      competingEndpoints.set(endpoint, runner);
    }
  }

  await Promise.all(
    [...competingEndpoints].map(async ([endpoint, runner]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${endpoint}/free`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        logger.warn(
          { error, runner, endpoint, target },
          "failed to release competing ComfyUI runner memory",
        );
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}
