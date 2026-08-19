import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";
import type { AdminTextRuntimeIdentity } from "./modules/admin-v2/content/text-generation";

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

type ProbeOperation = {
  ok: boolean;
  status: number;
  adminSourceRevision: string | null;
  error: string | null;
};

export type AdminTextProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  provider: string | null;
  pipelineUrl: string | null;
  model: string | null;
  adminSourceRevision: string | null;
  adminUrl: string | null;
  characterId: string | null;
  authMode: "cookie" | "authorization" | null;
  correlationId: string;
  requestIds: {
    characterAssist: string;
    productionDirections: string;
  };
  characterAssist: (ProbeOperation & {
    descriptionCharacters: number;
    nameIdeas: number;
    personalityCharacters: number;
    speakingStyleCharacters: number;
    firstMessageCharacters: number;
    visualBriefCharacters: number;
    runtime: AdminTextRuntimeIdentity | null;
  }) | null;
  productionDirections: (ProbeOperation & {
    directions: number;
    source: string | null;
    scenePromptCharacters: number;
    runtime: AdminTextRuntimeIdentity | null;
  }) | null;
  cleanup: {
    fixture: "not_created";
    immutableModerationAudit: "retained_by_authority";
  };
  error: { code: string; message: string } | null;
};

type RunAdminTextProbeInput = {
  adminUrl: string | null;
  characterId: string | null;
  cookie: string | null;
  authorization: string | null;
  provider: string | null;
  pipelineUrl: string | null;
  model: string | null;
  allowImmutableAudit: boolean;
  correlationId?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

type JsonEnvelope = {
  ok?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textLength(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().length
    : 0;
}

function runtimeIdentity(value: unknown): AdminTextRuntimeIdentity | null {
  const candidate = record(value);
  const provider = candidate?.provider;
  const pipelineUrl = candidate?.pipelineUrl;
  const model = candidate?.model;
  const sourceRevision = candidate?.sourceRevision;
  if (
    (provider !== "mock" && provider !== "pipeline") ||
    (typeof pipelineUrl !== "string" && pipelineUrl !== null) ||
    (typeof model !== "string" && model !== null) ||
    (typeof sourceRevision !== "string" && sourceRevision !== null)
  ) {
    return null;
  }
  return { provider, pipelineUrl, model, sourceRevision };
}

function isUsablePipelineIdentity(
  identity: AdminTextRuntimeIdentity | null,
): identity is AdminTextRuntimeIdentity {
  return (
    identity?.provider === "pipeline" &&
    textLength(identity.pipelineUrl) > 0 &&
    textLength(identity.model) > 0 &&
    textLength(identity.sourceRevision) > 0
  );
}

function sameRuntimeIdentity(
  left: AdminTextRuntimeIdentity,
  right: AdminTextRuntimeIdentity,
) {
  return (
    left.provider === right.provider &&
    left.pipelineUrl === right.pipelineUrl &&
    left.model === right.model &&
    left.sourceRevision === right.sourceRevision
  );
}

function responseError(status: number, envelope: JsonEnvelope | null) {
  const message = envelope?.error?.message;
  return typeof message === "string" && message.trim()
    ? message
    : `HTTP ${status}`;
}

async function postJson(
  fetchImpl: FetchLike,
  url: URL,
  body: unknown,
  auth: { cookie: string | null; authorization: string | null },
  requestId: string,
) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "idream-admin-text-launch-probe/1",
    "x-request-id": requestId,
  };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.authorization) headers.authorization = auth.authorization;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "manual",
  });
  let envelope: JsonEnvelope | null = null;
  try {
    envelope = (await response.json()) as JsonEnvelope;
  } catch {
    // A non-JSON success cannot prove either structured Admin contract.
  }
  return {
    response,
    envelope,
    adminSourceRevision:
      response.headers.get("x-idream-admin-source-revision")?.trim() || null,
  };
}

async function probeCharacterAssist(
  fetchImpl: FetchLike,
  baseUrl: URL,
  auth: { cookie: string | null; authorization: string | null },
  requestId: string,
): Promise<NonNullable<AdminTextProbeReport["characterAssist"]>> {
  try {
    const { response, envelope, adminSourceRevision } = await postJson(
      fetchImpl,
      new URL("/api/v2/admin/content/character-assist", baseUrl),
      {
        seed:
          "An adult portrait conservator who sketches rain-lit streets after work",
        style: "realistic",
      },
      auth,
      requestId,
    );
    const data = record(envelope?.data);
    const advanced = record(data?.advancedDetails);
    const runtime = runtimeIdentity(data?.runtime);
    const nameIdeas = Array.isArray(data?.nameIdeas)
      ? data.nameIdeas.filter(
          (name): name is string =>
            typeof name === "string" && name.trim().length > 0,
        ).length
      : 0;
    const result = {
      ok: false,
      status: response.status,
      adminSourceRevision,
      descriptionCharacters: textLength(data?.description),
      nameIdeas,
      personalityCharacters: textLength(advanced?.personality),
      speakingStyleCharacters: textLength(advanced?.speakingStyle),
      firstMessageCharacters: textLength(advanced?.firstMessage),
      visualBriefCharacters: textLength(advanced?.visualBrief),
      runtime,
      error: responseError(response.status, envelope),
    };
    const ok =
      response.ok &&
      envelope?.ok === true &&
      result.descriptionCharacters > 0 &&
      result.nameIdeas > 0 &&
      result.personalityCharacters > 0 &&
      result.speakingStyleCharacters > 0 &&
      result.firstMessageCharacters > 0 &&
      result.visualBriefCharacters > 0 &&
      isUsablePipelineIdentity(runtime);
    return { ...result, ok, error: ok ? null : result.error };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      adminSourceRevision: null,
      descriptionCharacters: 0,
      nameIdeas: 0,
      personalityCharacters: 0,
      speakingStyleCharacters: 0,
      firstMessageCharacters: 0,
      visualBriefCharacters: 0,
      runtime: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeProductionDirections(
  fetchImpl: FetchLike,
  baseUrl: URL,
  characterId: string,
  auth: { cookie: string | null; authorization: string | null },
  requestId: string,
): Promise<NonNullable<AdminTextProbeReport["productionDirections"]>> {
  try {
    const { response, envelope, adminSourceRevision } = await postJson(
      fetchImpl,
      new URL("/api/v2/admin/content/production/directions", baseUrl),
      {
        characterId,
        purpose: "model_eval",
        creativeBrief:
          "Four production-ready identity-preserving editorial portrait directions",
        consistencyMode: "strict",
      },
      auth,
      requestId,
    );
    const data = record(envelope?.data);
    const runtime = runtimeIdentity(data?.runtime);
    const directionRows = Array.isArray(data?.directions)
      ? data.directions.map(record).filter((row) => row !== null)
      : [];
    const scenePromptCharacters = directionRows.reduce(
      (total, direction) => total + textLength(direction.scenePrompt),
      0,
    );
    const source = typeof data?.source === "string" ? data.source : null;
    const structured = directionRows.every(
      (direction) =>
        [
          "title",
          "scenePrompt",
          "mood",
          "setting",
          "outfit",
          "camera",
          "lighting",
        ].every((key) => textLength(direction[key]) > 0),
    );
    const ok =
      response.ok &&
      envelope?.ok === true &&
      directionRows.length === 4 &&
      structured &&
      source === "model" &&
      isUsablePipelineIdentity(runtime);
    return {
      ok,
      status: response.status,
      adminSourceRevision,
      directions: directionRows.length,
      source,
      scenePromptCharacters,
      runtime,
      error: ok ? null : responseError(response.status, envelope),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      adminSourceRevision: null,
      directions: 0,
      source: null,
      scenePromptCharacters: 0,
      runtime: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAdminTextProbe(
  input: RunAdminTextProbeInput,
): Promise<AdminTextProbeReport> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const correlationId = input.correlationId ?? `admin-text-probe-${randomUUID()}`;
  const requestIds = {
    characterAssist: `${correlationId}-assist`,
    productionDirections: `${correlationId}-directions`,
  };
  const cleanup = {
    fixture: "not_created",
    immutableModerationAudit: "retained_by_authority",
  } as const;
  const authMode = input.cookie
    ? "cookie"
    : input.authorization
      ? "authorization"
      : null;
  const base = {
    checkedAt: startedAt.toISOString(),
    provider: input.provider,
    pipelineUrl: input.pipelineUrl,
    model: input.model,
    adminSourceRevision: null as string | null,
    adminUrl: input.adminUrl,
    characterId: input.characterId,
    authMode,
    correlationId,
    requestIds,
    cleanup,
  } as const;
  const configurationProblems = [
    input.provider !== "pipeline" ? "CHAT_PROVIDER must be pipeline" : null,
    !input.pipelineUrl ? "PIPELINE_API_URL is required" : null,
    !input.model ? "PIPELINE_CHAT_MODEL_DEFAULT is required" : null,
    !input.adminUrl ? "ADMIN_WEB_URL or --admin-url is required" : null,
    !input.characterId
      ? "ADMIN_TEXT_PROBE_CHARACTER_ID or --character-id is required"
      : null,
    !authMode
      ? "ADMIN_TEXT_PROBE_COOKIE or ADMIN_TEXT_PROBE_AUTHORIZATION is required"
      : null,
    !input.allowImmutableAudit
      ? "--allow-immutable-audit is required because Character Assist retains immutable moderation events"
      : null,
  ].filter((problem): problem is string => problem !== null);
  if (configurationProblems.length > 0) {
    return {
      ...base,
      ok: false,
      durationMs: now().getTime() - startedAt.getTime(),
      characterAssist: null,
      productionDirections: null,
      error: {
        code: "admin_text_probe_configuration_invalid",
        message: configurationProblems.join("; "),
      },
    };
  }

  let adminUrl: URL;
  try {
    adminUrl = new URL(input.adminUrl!);
  } catch {
    return {
      ...base,
      ok: false,
      durationMs: now().getTime() - startedAt.getTime(),
      characterAssist: null,
      productionDirections: null,
      error: {
        code: "admin_text_probe_configuration_invalid",
        message: "ADMIN_WEB_URL is not a valid URL",
      },
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const auth = { cookie: input.cookie, authorization: input.authorization };
  const characterAssist = await probeCharacterAssist(
    fetchImpl,
    adminUrl,
    auth,
    requestIds.characterAssist,
  );
  const productionDirections = await probeProductionDirections(
    fetchImpl,
    adminUrl,
    input.characterId!,
    auth,
    requestIds.productionDirections,
  );
  const characterRuntime = characterAssist.runtime;
  const directionsRuntime = productionDirections.runtime;
  const runtimeIdentityPresent =
    isUsablePipelineIdentity(characterRuntime) &&
    isUsablePipelineIdentity(directionsRuntime);
  const runtimeIdentityMatches =
    runtimeIdentityPresent && sameRuntimeIdentity(characterRuntime, directionsRuntime);
  const adminSourceRevision =
    characterAssist.adminSourceRevision &&
    characterAssist.adminSourceRevision ===
      productionDirections.adminSourceRevision
      ? characterAssist.adminSourceRevision
      : null;
  const observedRuntime = characterRuntime ?? directionsRuntime;
  const ok =
    characterAssist.ok &&
    productionDirections.ok &&
    runtimeIdentityMatches &&
    Boolean(adminSourceRevision);
  const error = ok
    ? null
    : !adminSourceRevision
      ? {
          code: "admin_text_probe_admin_revision_missing",
          message: "Admin BFF did not return one stable source revision from both routes",
        }
      : !runtimeIdentityPresent
      ? {
          code: "admin_text_probe_runtime_identity_missing",
          message: "Main did not return a complete runtime identity from both Admin text routes",
        }
      : !runtimeIdentityMatches
        ? {
            code: "admin_text_probe_runtime_identity_mismatch",
            message: "Main Admin text routes reported different runtime identities",
          }
        : {
            code: "admin_text_probe_failed",
            message: [characterAssist.error, productionDirections.error]
              .filter(Boolean)
              .join("; "),
          };
  return {
    ...base,
    provider: observedRuntime?.provider ?? null,
    pipelineUrl: observedRuntime?.pipelineUrl ?? null,
    model: observedRuntime?.model ?? null,
    adminSourceRevision,
    ok,
    durationMs: now().getTime() - startedAt.getTime(),
    characterAssist,
    productionDirections,
    error,
  };
}

async function main() {
  const report = await runAdminTextProbe({
    adminUrl: probeCliArg("admin-url") ?? process.env.ADMIN_WEB_URL ?? null,
    characterId:
      probeCliArg("character-id") ??
      process.env.ADMIN_TEXT_PROBE_CHARACTER_ID ??
      null,
    cookie: process.env.ADMIN_TEXT_PROBE_COOKIE ?? null,
    authorization: process.env.ADMIN_TEXT_PROBE_AUTHORIZATION ?? null,
    provider: process.env.CHAT_PROVIDER ?? null,
    pipelineUrl: process.env.PIPELINE_API_URL ?? null,
    model: process.env.PIPELINE_CHAT_MODEL_DEFAULT ?? null,
    allowImmutableAudit: process.argv.includes("--allow-immutable-audit"),
  });
  const reportPath = probeReportPath("adminTextProbe");
  if (reportPath) await writeProbeReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function isCliEntrypoint() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isCliEntrypoint()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
