import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";

type ProbeOptions = {
  candidateKeys: string[];
  report: string | null;
  requireReady: boolean;
};

type CandidateDefinition = {
  key: string;
  profileId: string;
  expectedIntent?: string;
  expectedRunner: "comfyui";
  expectedPipelineModel?: string;
  expectedWorkflowKey?: string;
  expectedSourceSha256?: string;
  minSampleCount: number;
  requireActive: boolean;
  requireConsistency: boolean;
  requireVerification: boolean;
};

type FileCheck = {
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  required: boolean;
};

type ComponentCheck = {
  key: string;
  status: string;
  path: string | null;
  tone: "good" | "bad" | "warn";
};

type AssetInspection = {
  path: string;
  inspected: boolean;
  error: string | null;
  sha256: string | null;
  headerBytes: number | null;
  tensorCount: number | null;
  metadataKeys: string[];
  hasComfyUiWorkflow: boolean;
  hasCheckpointLoaderSimple: boolean;
  hasClipTensors: boolean;
  hasVaeTensors: boolean;
  diffusionModelOnly: boolean;
  hasFp8ScaleTensors: boolean;
  suggestedRuntime: "sd_cpp_external_components" | "comfyui_fp8_krea2_checkpoint" | "unknown";
};

type CandidateReport = {
  key: string;
  profileId: string;
  label: string;
  found: boolean;
  runner: string | null;
  pipelineModel: string | null;
  workflowKey: string | null;
  status: string | null;
  enabled: boolean;
  rolloutPercent: number | null;
  expectedIntent: string | null;
  verificationStatus: string | null;
  failureMode: string | null;
  sampleCount: number | null;
  successRate: number | null;
  consistencyRate: number | null;
  quarantined: boolean;
  readyForPublish: boolean;
  unsafeExposure: boolean;
  files: FileCheck[];
  assetInspection: AssetInspection | null;
  components: ComponentCheck[];
  blockedReasons: string[];
  conclusion: string;
};

type ProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  candidateKeys: string[];
  requireReady: boolean;
  candidates: CandidateReport[];
  failureReasons: string[];
  error: { code: string; message: string; retryable?: boolean } | null;
};

export const generationModelCandidateDefinitions: CandidateDefinition[] = [
  {
    key: "redcraft_krea2_default",
    profileId: "seed-profile-image-default-v1",
    expectedRunner: "comfyui",
    expectedPipelineModel: "redcraft-krea2-redmix3-fp8",
    expectedWorkflowKey: "redcraft-krea2-redmix3-txt2img",
    minSampleCount: 1,
    requireActive: true,
    requireConsistency: false,
    requireVerification: false,
  },
  {
    key: "redcraft_krea2_text",
    profileId: "seed-profile-sdcpp-redcraft-krea2-text-v1",
    expectedIntent: "comfyui_krea2_text_checkpoint",
    expectedRunner: "comfyui",
    minSampleCount: 20,
    requireActive: false,
    requireConsistency: true,
    requireVerification: true,
  },
  {
    key: "redcraft_krea2_redmix3",
    profileId: "seed-profile-redcraft-krea2-redmix3-v1",
    expectedIntent: "redmix3_text_to_image_comparison",
    expectedRunner: "comfyui",
    expectedPipelineModel: "redcraft-krea2-redmix3-fp8",
    expectedWorkflowKey: "redcraft-krea2-redmix3-txt2img",
    expectedSourceSha256:
      "F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA",
    minSampleCount: 1,
    requireActive: false,
    requireConsistency: false,
    requireVerification: true,
  },
  {
    key: "darkbeast_flux2_klein_bfs",
    profileId: "seed-profile-sdcpp-darkbeast-krea2-img2img-v1",
    expectedIntent: "image_edit_identity_source_comparison",
    expectedRunner: "comfyui",
    expectedPipelineModel: "darkbeast-flux2-klein-9b-bfs",
    expectedWorkflowKey: "darkbeast-flux2-klein-9b-multi-reference",
    expectedSourceSha256:
      "B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3",
    minSampleCount: 1,
    requireActive: false,
    requireConsistency: true,
    requireVerification: true,
  },
];

const candidateKeyAliases: Readonly<Record<string, string>> = {
  pornmaster_zimage_default: "redcraft_krea2_default",
};

export function resolveGenerationModelCandidateKey(key: string) {
  return candidateKeyAliases[key] ?? key;
}

export function evaluateGenerationModelCandidateActivation(input: {
  requireActive: boolean;
  status: string;
  enabled: boolean;
  rolloutPercent: number;
}) {
  const blockedReasons = [
    input.requireActive && input.status !== "active"
      ? `status is ${input.status}, expected active`
      : null,
    input.requireActive && !input.enabled ? "profile is disabled" : null,
    input.requireActive && input.rolloutPercent !== 100
      ? `rolloutPercent is ${input.rolloutPercent}, expected 100`
      : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    ready: blockedReasons.length === 0,
    blockedReasons,
  };
}

export function evaluateGenerationModelCandidateSourceHash(input: {
  expected: string | undefined;
  observed: string | null;
}) {
  if (!input.expected) {
    return { ready: true, blockedReason: null };
  }
  const expected = input.expected.toUpperCase();
  const observed = input.observed?.toUpperCase() ?? null;
  if (!observed) {
    return {
      ready: false,
      blockedReason: "source SHA-256 was not evaluated",
    };
  }
  if (observed !== expected) {
    return {
      ready: false,
      blockedReason: `source SHA-256 is ${observed}, expected ${expected}`,
    };
  }
  return { ready: true, blockedReason: null };
}

export function shouldVerifyGenerationModelCandidateSourceHash(input: {
  requireReady: boolean;
  status: string;
  enabled: boolean;
  rolloutPercent: number;
}) {
  return (
    input.requireReady ||
    input.status === "active" ||
    input.enabled ||
    input.rolloutPercent > 0
  );
}

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function readOptions(): ProbeOptions {
  const candidateKeys = parseCandidateKeys(
    readArg("candidate") ?? process.env.GENERATION_MODEL_CANDIDATE_KEYS ?? "",
  );
  return {
    candidateKeys,
    report: readArg("report") ?? process.env.GENERATION_MODEL_CANDIDATE_PROBE_REPORT ?? null,
    requireReady:
      readFlag("require-ready") ||
      process.env.GENERATION_MODEL_CANDIDATE_PROBE_REQUIRE_READY === "1",
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe(options);

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const definitions = selectedCandidateDefinitions(options.candidateKeys);
    const unknownCandidateKeys = options.candidateKeys.filter(
      (key) =>
        !generationModelCandidateDefinitions.some(
          (candidate) => candidate.key === key,
        ),
    );
    if (unknownCandidateKeys.length > 0) {
      return failedReport({
        checkedAt,
        durationMs: Date.now() - startedAt,
        options,
        code: "unknown_generation_model_candidate",
        message: `Unknown candidate key(s): ${unknownCandidateKeys.join(", ")}`,
        retryable: false,
      });
    }
    const profiles = await prisma.generationModelProfile.findMany({
      where: { id: { in: definitions.map((candidate) => candidate.profileId) } },
      select: {
        id: true,
        label: true,
        runner: true,
        pipelineModel: true,
        workflowKey: true,
        sourceModelPath: true,
        convertedModelPath: true,
        status: true,
        enabled: true,
        rolloutPercent: true,
        runnerConfig: true,
        dryRunSummary: true,
        mode: true,
      },
    });
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const candidates = await Promise.all(
      definitions.map((candidate) =>
        inspectCandidate(
          candidate,
          profileById.get(candidate.profileId),
          options.requireReady,
        ),
      ),
    );
    const failureReasons = candidates.flatMap((candidate) => {
      const reasons: string[] = [];
      if (!candidate.found) reasons.push(`${candidate.key}: profile missing`);
      if (candidate.unsafeExposure) {
        reasons.push(`${candidate.key}: not publishable but exposed to traffic`);
      }
      if (options.requireReady && !candidate.readyForPublish) {
        reasons.push(`${candidate.key}: ${candidate.blockedReasons.join("; ") || "not ready"}`);
      }
      return reasons;
    });

    return {
      ok: failureReasons.length === 0,
      checkedAt,
      durationMs: Date.now() - startedAt,
      candidateKeys: definitions.map((candidate) => candidate.key),
      requireReady: options.requireReady,
      candidates,
      failureReasons,
      error:
        failureReasons.length === 0
          ? null
          : {
              code: options.requireReady
                ? "generation_model_candidates_not_ready"
                : "generation_model_candidates_unsafe",
              message: failureReasons.join("; "),
              retryable: false,
            },
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      candidateKeys: options.candidateKeys.length > 0
        ? options.candidateKeys
        : generationModelCandidateDefinitions.map((candidate) => candidate.key),
      requireReady: options.requireReady,
      candidates: [],
      failureReasons: ["generation model candidate probe failed"],
      error: {
        code: "generation_model_candidate_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}

function parseCandidateKeys(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(resolveGenerationModelCandidateKey),
    ),
  ];
}

function selectedCandidateDefinitions(candidateKeys: string[]) {
  if (candidateKeys.length === 0) return generationModelCandidateDefinitions;
  const wanted = new Set(candidateKeys);
  return generationModelCandidateDefinitions.filter((candidate) =>
    wanted.has(candidate.key),
  );
}

function failedReport(input: {
  checkedAt: string;
  code: string;
  durationMs: number;
  message: string;
  options: ProbeOptions;
  retryable: boolean;
}): ProbeReport {
  return {
    ok: false,
    checkedAt: input.checkedAt,
    durationMs: input.durationMs,
    candidateKeys: input.options.candidateKeys,
    requireReady: input.options.requireReady,
    candidates: [],
    failureReasons: [input.message],
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    },
  };
}

async function inspectCandidate(
  candidate: CandidateDefinition,
  profile:
    | {
        id: string;
        label: string;
        runner: string;
        pipelineModel: string;
        workflowKey: string | null;
        sourceModelPath: string | null;
        convertedModelPath: string | null;
        status: string;
        enabled: boolean;
        rolloutPercent: number;
        runnerConfig: unknown;
        dryRunSummary: unknown;
        mode: string;
      }
    | undefined,
  requireReady: boolean,
): Promise<CandidateReport> {
  if (!profile) {
    return {
      key: candidate.key,
      profileId: candidate.profileId,
      label: "",
      found: false,
      runner: null,
      pipelineModel: null,
      workflowKey: null,
      status: null,
      enabled: false,
      rolloutPercent: null,
      expectedIntent: candidate.expectedIntent ?? null,
      verificationStatus: null,
      failureMode: null,
      sampleCount: null,
      successRate: null,
      consistencyRate: null,
      quarantined: false,
      readyForPublish: false,
      unsafeExposure: false,
      files: [],
      assetInspection: null,
      components: [],
      blockedReasons: ["profile missing"],
      conclusion: "missing_profile",
    };
  }

  const runnerConfig = jsonRecord(profile.runnerConfig);
  const dryRunSummary = jsonRecord(profile.dryRunSummary);
  const verificationStatus = stringField(runnerConfig, "verificationStatus");
  const failureMode = stringField(dryRunSummary, "failureMode");
  const sampleCount = numberField(dryRunSummary, "sampleCount");
  const successRate = numberField(dryRunSummary, "successRate");
  const consistencyRate = firstNumberField(dryRunSummary, [
    "consistencyRate",
    "consistencyPassRate",
    "identityConsistencyRate",
    "manualConsistencyRate",
  ]);
  const files = await fileChecksForProfile(profile, runnerConfig);
  const verifySourceHash =
    Boolean(candidate.expectedSourceSha256) &&
    shouldVerifyGenerationModelCandidateSourceHash({
      requireReady,
      status: profile.status,
      enabled: profile.enabled,
      rolloutPercent: profile.rolloutPercent,
    });
  const assetInspection = await inspectSafetensorsAsset(
    profile.sourceModelPath ?? stringField(runnerConfig, "diffusionModelPath"),
    verifySourceHash,
  );
  const sourceHash = evaluateGenerationModelCandidateSourceHash({
    expected: verifySourceHash ? candidate.expectedSourceSha256 : undefined,
    observed: assetInspection?.sha256 ?? null,
  });
  const components = componentChecks(runnerConfig.componentStatus);
  const badComponents = components.filter((component) => component.tone === "bad");
  const activation = evaluateGenerationModelCandidateActivation({
    requireActive: candidate.requireActive,
    status: profile.status,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
  });
  const blockedReasons = [
    profile.runner !== candidate.expectedRunner
      ? `runner is ${profile.runner}, expected ${candidate.expectedRunner}`
      : null,
    candidate.expectedPipelineModel &&
    profile.pipelineModel !== candidate.expectedPipelineModel
      ? `pipelineModel is ${profile.pipelineModel}, expected ${candidate.expectedPipelineModel}`
      : null,
    candidate.expectedWorkflowKey &&
    profile.workflowKey !== candidate.expectedWorkflowKey
      ? `workflowKey is ${profile.workflowKey ?? "missing"}, expected ${candidate.expectedWorkflowKey}`
      : null,
    candidate.expectedIntent && stringField(runnerConfig, "templateIntent") !== candidate.expectedIntent
      ? `templateIntent is ${stringField(runnerConfig, "templateIntent") || "missing"}`
      : null,
    candidate.expectedSourceSha256 &&
    stringField(runnerConfig, "civitaiSha256")?.toUpperCase() !==
      candidate.expectedSourceSha256.toUpperCase()
      ? `configured source SHA-256 is ${stringField(runnerConfig, "civitaiSha256") || "missing"}`
      : null,
    sourceHash.blockedReason,
    candidate.requireVerification && !isPassedVerificationStatus(verificationStatus)
      ? `verificationStatus is ${verificationStatus || "missing"}`
      : null,
    failureMode ? `failureMode is ${failureMode}` : null,
    sampleCount === null || sampleCount < candidate.minSampleCount
      ? `sampleCount is ${sampleCount ?? "missing"}`
      : null,
    successRate !== null && successRate < 0.8 ? `successRate is ${successRate}` : null,
    ...activation.blockedReasons,
    candidate.requireConsistency && profile.mode === "image" && (consistencyRate === null || consistencyRate < 0.8)
      ? `consistencyRate is ${consistencyRate ?? "missing"}`
      : null,
    ...files
      .filter((file) => file.required && !file.exists)
      .map((file) => `${file.label} file missing: ${file.path}`),
    ...badComponents.map((component) => `component ${component.key} is ${component.status}`),
  ].filter((reason): reason is string => Boolean(reason));
  const readyForPublish = blockedReasons.length === 0;
  const quarantined =
    profile.status === "draft" && profile.enabled === false && profile.rolloutPercent === 0;
  const unsafeExposure =
    !readyForPublish &&
    (profile.status === "active" || profile.enabled === true || profile.rolloutPercent > 0);

  return {
    key: candidate.key,
    profileId: candidate.profileId,
    label: profile.label,
    found: true,
    runner: profile.runner,
    pipelineModel: profile.pipelineModel,
    workflowKey: profile.workflowKey,
    status: profile.status,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
    expectedIntent: candidate.expectedIntent ?? null,
    verificationStatus,
    failureMode,
    sampleCount,
    successRate,
    consistencyRate,
    quarantined,
    readyForPublish,
    unsafeExposure,
    files,
    assetInspection,
    components,
    blockedReasons,
    conclusion: readyForPublish
      ? "ready_for_publish"
      : quarantined
        ? "not_ready_but_quarantined"
        : "not_ready_and_needs_attention",
  };
}

async function inspectSafetensorsAsset(
  filePath: string | null,
  computeSha256: boolean,
): Promise<AssetInspection | null> {
  if (!filePath || !filePath.endsWith(".safetensors")) return null;
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      inspected: false,
      error: "file_missing",
      sha256: null,
      headerBytes: null,
      tensorCount: null,
      metadataKeys: [],
      hasComfyUiWorkflow: false,
      hasCheckpointLoaderSimple: false,
      hasClipTensors: false,
      hasVaeTensors: false,
      diffusionModelOnly: false,
      hasFp8ScaleTensors: false,
      suggestedRuntime: "unknown",
    };
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let sha256: string | null = null;
  try {
    sha256 = computeSha256
      ? await calculateGenerationModelSourceSha256(filePath)
      : null;
    handle = await open(filePath, "r");
    const sizeBuffer = Buffer.alloc(8);
    await handle.read(sizeBuffer, 0, 8, 0);
    const headerBytes = Number(sizeBuffer.readBigUInt64LE(0));
    if (!Number.isFinite(headerBytes) || headerBytes <= 0 || headerBytes > 8 * 1024 * 1024) {
      return failedAssetInspection(
        filePath,
        "invalid_or_too_large_header",
        headerBytes,
        sha256,
      );
    }
    const headerBuffer = Buffer.alloc(headerBytes);
    await handle.read(headerBuffer, 0, headerBytes, 8);
    const header = JSON.parse(headerBuffer.toString("utf8")) as unknown;
    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      return failedAssetInspection(
        filePath,
        "invalid_header_json",
        headerBytes,
        sha256,
      );
    }

    const headerRecord = header as Record<string, unknown>;
    const tensorKeys = Object.keys(headerRecord).filter((key) => key !== "__metadata__");
    const metadata = jsonRecord(headerRecord.__metadata__);
    const metadataText = Object.entries(metadata)
      .map(([key, value]) => `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n")
      .toLowerCase();
    const hasComfyUiWorkflow =
      metadataText.includes("comfyui") ||
      metadataText.includes("class_type") ||
      metadataText.includes("ksampler");
    const hasCheckpointLoaderSimple = metadataText.includes("checkpointloadersimple");
    const hasFp8ScaleTensors =
      metadataText.includes("fp8") ||
      tensorKeys.some((key) => key.endsWith(".weight_scale") || key.endsWith(".input_scale"));
    const hasClipTensors = tensorKeys.some((key) => /(^|\.)(clip|text_encoder|conditioner)(\.|$)/i.test(key));
    const hasVaeTensors = tensorKeys.some((key) => /(^|\.)(vae|first_stage_model|decoder|encoder)(\.|$)/i.test(key));
    const diffusionModelOnly =
      tensorKeys.length > 0 && tensorKeys.every((key) => key.startsWith("model.diffusion_model."));
    const suggestedRuntime =
      hasComfyUiWorkflow && hasCheckpointLoaderSimple && hasFp8ScaleTensors
        ? "comfyui_fp8_krea2_checkpoint"
        : diffusionModelOnly
          ? "sd_cpp_external_components"
          : "unknown";

    return {
      path: filePath,
      inspected: true,
      error: null,
      sha256,
      headerBytes,
      tensorCount: tensorKeys.length,
      metadataKeys: Object.keys(metadata),
      hasComfyUiWorkflow,
      hasCheckpointLoaderSimple,
      hasClipTensors,
      hasVaeTensors,
      diffusionModelOnly,
      hasFp8ScaleTensors,
      suggestedRuntime,
    };
  } catch (error) {
    return failedAssetInspection(
      filePath,
      error instanceof Error ? error.message : String(error),
      null,
      sha256,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function calculateGenerationModelSourceSha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex").toUpperCase();
}

function failedAssetInspection(
  filePath: string,
  error: string,
  headerBytes: number | null,
  sha256: string | null = null,
): AssetInspection {
  return {
    path: filePath,
    inspected: false,
    error,
    sha256,
    headerBytes,
    tensorCount: null,
    metadataKeys: [],
    hasComfyUiWorkflow: false,
    hasCheckpointLoaderSimple: false,
    hasClipTensors: false,
    hasVaeTensors: false,
    diffusionModelOnly: false,
    hasFp8ScaleTensors: false,
    suggestedRuntime: "unknown",
  };
}

async function fileChecksForProfile(
  profile: {
    sourceModelPath: string | null;
    convertedModelPath: string | null;
  },
  runnerConfig: Record<string, unknown>,
) {
  const rawFiles = [
    { label: "sourceModelPath", path: profile.sourceModelPath, required: true },
    { label: "convertedModelPath", path: profile.convertedModelPath, required: false },
    { label: "diffusionModelPath", path: stringField(runnerConfig, "diffusionModelPath"), required: true },
    { label: "llmPath", path: stringField(runnerConfig, "llmPath"), required: true },
    { label: "vaePath", path: stringField(runnerConfig, "vaePath"), required: true },
    { label: "workflowPath", path: stringField(runnerConfig, "workflowPath"), required: true },
    { label: "modelPath", path: stringField(runnerConfig, "modelPath"), required: true },
    { label: "cliPath", path: stringField(runnerConfig, "cliPath"), required: false },
    ...componentFileHints(runnerConfig.componentStatus),
  ];
  const unique = new Map<string, { label: string; path: string; required: boolean }>();
  for (const file of rawFiles) {
    if (!file.path) continue;
    const existing = unique.get(file.path);
    unique.set(file.path, {
      label: existing ? `${existing.label},${file.label}` : file.label,
      path: file.path,
      required: Boolean(existing?.required || file.required),
    });
  }

  return Promise.all([...unique.values()].map(toFileCheck));
}

async function toFileCheck(input: { label: string; path: string; required: boolean }): Promise<FileCheck> {
  const exists = existsSync(input.path);
  const sizeBytes = exists ? (await stat(input.path)).size : null;
  return { ...input, exists, sizeBytes };
}

function componentFileHints(value: unknown) {
  return componentChecks(value)
    .filter((component) => component.path)
    .map((component) => ({
      label: `component:${component.key}`,
      path: component.path ?? "",
      required: true,
    }));
}

function componentChecks(value: unknown): ComponentCheck[] {
  const componentStatus = jsonRecord(value);
  return Object.entries(componentStatus).map(([key, rawValue]) => {
    const parsed = parseComponentStatus(rawValue);
    return {
      key,
      status: parsed.status || "configured",
      path: parsed.path,
      tone: componentTone(parsed.status),
    };
  });
}

function parseComponentStatus(value: unknown) {
  const component = jsonRecord(value);
  const rawStatus = typeof value === "string" ? value : stringField(component, "status") ?? "";
  const path = stringField(component, "path");
  const separatorIndex = rawStatus.indexOf(":");
  if (separatorIndex <= 0) return { status: rawStatus, path };
  const status = rawStatus.slice(0, separatorIndex);
  const componentPath = rawStatus.slice(separatorIndex + 1);
  return { status, path: componentPath || path };
}

function componentTone(status: string): ComponentCheck["tone"] {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("missing") ||
    normalized.includes("failed") ||
    normalized.includes("unsupported") ||
    normalized.includes("not_imported") ||
    normalized.includes("required") ||
    normalized.includes("requires_") ||
    normalized.includes("unavailable")
  ) {
    return "bad";
  }
  if (
    normalized.includes("available") ||
    normalized.includes("passed") ||
    normalized.includes("verified") ||
    normalized === "ok" ||
    normalized === "present"
  ) {
    return "good";
  }
  return "warn";
}

function isPassedVerificationStatus(status: string | null) {
  return status === "passed" || status === "verified" || status === "manual_passed";
}

function firstNumberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numberField(record, key);
    if (value !== null) return value;
  }
  return null;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const entryPath = process.argv[1];
if (
  entryPath &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
