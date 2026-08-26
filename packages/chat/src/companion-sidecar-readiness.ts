import {
  companionReadinessSchema,
  type CompanionReadiness,
} from "@idream/shared/chat/companion-runtime";

const verifiedByEndpoint = new Map<string, CompanionReadiness>();

function endpoint(value: string): string {
  return value.replace(/\/$/, "");
}

export async function probeCompanionSidecar(input: {
  baseUrl: string;
  token: string;
  expectedProvider: string;
  expectedBaseUrl: string;
  expectedModel: string;
  full?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CompanionReadiness> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = endpoint(input.baseUrl);
  const response = await fetchImpl(
    `${baseUrl}/readyz${input.full ? "?full=1" : ""}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
      },
      // Full proof may legitimately consume provider(60s)+ingest(30s)+maintain(120s).
      signal: AbortSignal.timeout(input.timeoutMs ?? (input.full ? 240_000 : 10_000)),
    },
  );
  if (!response.ok) {
    throw new Error(`companion sidecar readiness failed with HTTP ${response.status}`);
  }
  const readiness = companionReadinessSchema.parse(await response.json());
  if (
    readiness.provider.name !== input.expectedProvider ||
    readiness.provider.baseUrl.replace(/\/$/, "") !== input.expectedBaseUrl.replace(/\/$/, "") ||
    readiness.provider.model !== input.expectedModel
  ) {
    throw new Error("companion sidecar resolved a different provider profile");
  }
  verifiedByEndpoint.set(baseUrl, readiness);
  return readiness;
}

/** The digest is usable only after the same process completed authenticated readiness. */
export function verifiedCompanionProfileDigest(
  baseUrl: string,
  mode: "normal" | "private",
): string {
  const readiness = verifiedByEndpoint.get(endpoint(baseUrl));
  if (!readiness) throw new Error("companion profile digest is not readiness-verified");
  return readiness.profiles[mode].executionCompositionDigest;
}

/** Runtime traces record the host-provided igrep release proven by readiness. */
export function verifiedCompanionRuntimeVersions(
  baseUrl: string,
): Pick<CompanionReadiness, "igrepVersion" | "pluginVersion"> {
  const readiness = verifiedByEndpoint.get(endpoint(baseUrl));
  if (!readiness) throw new Error("companion runtime versions are not readiness-verified");
  return {
    igrepVersion: readiness.igrepVersion,
    pluginVersion: readiness.pluginVersion,
  };
}
