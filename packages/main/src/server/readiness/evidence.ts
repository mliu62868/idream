import { z } from "zod";

// SPEC: 上线就绪探针的 evidence 契约 —— 12 个 probe-*.ts 作为独立进程跑真实依赖后写 JSON，
//       launch-readiness.ts 经 *_PROBE_REPORT 环境变量读回来判定门禁。本文件是这条进程边界上
//       唯一的形状定义：生产端 import 接口来标注自己写出的 report，消费端 import 同一份接口来读。
// INTENT: 进程边界是真 seam，不合并；要收的只是"契约以前只存在于消费端"这件事。以前生产端一个
//         类型都不导出，字段改名只能靠消费端手写校验在运行时冒出来一句 problems 字符串。
// INTENT: 用 zod 而不是纯 TS 类型 —— JSON 跨进程后类型不生效，读文件那一刻必须有运行时兜底。
//         schema 的返回类型被标注成对应接口，所以 schema 和接口不可能各自漂移（tsc 拦住）。
// INVARIANT: decode* 必须与它取代的旧 normalize* 逐字段等价（含"数组也算 record"这个既有行为），
//            否则 check:launch 的判定会变。等价性由 launch-readiness.test.ts 与差分回归共同守住。

// INVARIANT: 复刻旧 isRecord —— 它只判 `typeof === "object" && !== null`，故意保留没有
// Array.isArray 守卫这一点：数组当年就被当成 record（取任何 key 都是 undefined，全部走兜底）。
function isRecordLike(value: unknown) {
  return typeof value === "object" && value !== null;
}

/** 数组摊平成对象（下标变成 key，于是任何字段都取不到），让 z.object 的接受面与旧 isRecord 对齐。 */
function asPlainRecord(value: unknown) {
  return Array.isArray(value) ? { ...value } : value;
}

// 以下原语逐条对应旧 normalizer 里的 `typeof x === "…" ? x : <兜底>`。
/** `typeof x === "string" ? x : null` */
const nullableText = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
/** `typeof x === "string" ? x : undefined` */
const optionalText = z.string().optional().catch(undefined);
/** `typeof x === "number" ? x : undefined` */
const optionalCount = z.number().optional().catch(undefined);
/** `typeof x === "boolean" ? x : false` */
const flag = z
  .boolean()
  .optional()
  .catch(false)
  .transform((value) => value ?? false);
/** `typeof x === "boolean" ? x : undefined` */
const optionalFlag = z.boolean().optional().catch(undefined);
/** `typeof x === "boolean" ? x : null` */
const nullableFlag = z
  .boolean()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);

// INVARIANT: 直译 `isRecord(x) ? {…} : null`。两个坑都踩过了，别"简化"回去：
//  1) 不能写 z.object(...).nullish().catch(null) —— 缺字段时 catch 不短路，整份报告会解析失败；
//  2) .optional() 不能省 —— 少了它，key 缺席时 z.object 直接报 invalid_type 而不是走 transform。
function nullableObject<T extends z.ZodRawShape>(shape: T) {
  const inner = z.object(shape);
  return z
    .unknown()
    .optional()
    .transform((value) => (isRecordLike(value) ? inner.parse(asPlainRecord(value)) : null));
}

/** 顶层 report：非对象（含 null / 标量）时旧 normalizer 返回 loadError 兜底。 */
function decodeTopLevel<T extends { ok?: boolean; loadError?: string }>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  // INVARIANT: 每个叶子都有兜底，safeParse 理论上不会失败；真失败也要 fail closed，不能抛穿门禁。
  const parsed = isRecordLike(value)
    ? schema.safeParse(asPlainRecord(value))
    : ({ success: false } as const);
  return parsed.success
    ? parsed.data
    : ({ ok: false, loadError: "probe report is not a JSON object" } as T);
}

// SPEC: 生产端视角的同一份契约 —— probe 每次都会写的字段一律必填，改名/漏写/写错类型都是编译错误。
// INTENT: 消费端的 XProbeEvidence 全字段可选，是因为它要容忍任意脏 JSON；生产端不该沾这份宽容。
//         loadError 是消费端读文件失败时才注入的通道，生产端永远不写，所以在这里剔除。
//         Optional 用来列出"按执行路径可能整个省略"的键（省略后 JSON.stringify 会直接丢掉该 key）。
export type ProbeReportOf<T, Optional extends keyof T = never> = Required<
  Omit<T, "loadError" | Optional>
> &
  Pick<T, Optional>;

// SPEC: 所有 probe 的失败详情都长这样。retryable 由多数 probe 实际写出，消费端目前不读，
//       但它属于线上契约的一部分，必须被声明，否则生产端写它就是"未声明字段"。
export interface ProbeErrorEvidence {
  code?: string;
  message?: string;
  retryable?: boolean;
}

const probeError = nullableObject({ code: optionalText, message: optionalText });

// ---------------------------------------------------------------------------
// image pipeline（生产端在 packages/gen，跨包，这里只声明消费契约）
// ---------------------------------------------------------------------------

export interface GenBlobAuthorityEvidence {
  provider?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  root?: string | null;
}

const genBlobAuthorityEvidence = nullableObject({
  provider: nullableText,
  endpoint: nullableText,
  bucket: nullableText,
  root: nullableText,
});

export interface ImagePipelineProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  pipelineUrl?: string | null;
  backendKind?: string | null;
  backendTarget?: string | null;
  workflowKey?: string | null;
  workflowVersion?: number | null;
  model?: string | null;
  orientation?: string;
  count?: number;
  blobAuthority?: GenBlobAuthorityEvidence | null;
  blobRoot?: string | null;
  generationJobId?: string;
  loadError?: string;
  terminal?: {
    ref?: string | null;
    checksum?: string | null;
    outcome?: string | null;
    assets?: number;
    error?: ProbeErrorEvidence | null;
  } | null;
  /** Legacy pre-TerminalRecord evidence; retained only so old reports decode and fail closed clearly. */
  finalize?: {
    kind?: string | null;
    assets?: number;
    error?: ProbeErrorEvidence | null;
  } | null;
}

const imagePipelineProbeEvidenceSchema: z.ZodType<ImagePipelineProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  pipelineUrl: nullableText,
  backendKind: nullableText,
  backendTarget: nullableText,
  workflowKey: nullableText,
  workflowVersion: z
    .number()
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  model: nullableText,
  orientation: optionalText,
  count: optionalCount,
  blobAuthority: genBlobAuthorityEvidence,
  blobRoot: nullableText,
  generationJobId: optionalText,
  terminal: nullableObject({
    ref: nullableText,
    checksum: nullableText,
    outcome: nullableText,
    assets: z
      .number()
      .optional()
      .catch(0)
      .transform((value) => value ?? 0),
    error: probeError,
  }),
  finalize: nullableObject({
    kind: nullableText,
    // INVARIANT: 旧 normalizer 这里的兜底是 0 而不是 undefined，别顺手改成 optionalCount。
    assets: z
      .number()
      .optional()
      .catch(0)
      .transform((value) => value ?? 0),
    error: probeError,
  }),
});

export function decodeImagePipelineProbeEvidence(value: unknown): ImagePipelineProbeEvidence {
  return decodeTopLevel(imagePipelineProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// video generation
// ---------------------------------------------------------------------------

export interface VideoGenerationProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  backendKind?: string | null;
  backendTarget?: string | null;
  workflowKey?: string | null;
  workflowVersion?: number | null;
  model?: string | null;
  seconds?: number;
  referenceSha256?: string | null;
  generationJobId?: string;
  blobAuthority?: GenBlobAuthorityEvidence | null;
  loadError?: string;
  terminal?: {
    ref?: string | null;
    checksum?: string | null;
    outcome?: string | null;
    assets?: number;
    error?: ProbeErrorEvidence | null;
  } | null;
}

const videoGenerationProbeEvidenceSchema: z.ZodType<VideoGenerationProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  backendKind: nullableText,
  backendTarget: nullableText,
  workflowKey: nullableText,
  workflowVersion: z
    .number()
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  model: nullableText,
  seconds: optionalCount,
  referenceSha256: nullableText,
  generationJobId: optionalText,
  blobAuthority: genBlobAuthorityEvidence,
  terminal: nullableObject({
    ref: nullableText,
    checksum: nullableText,
    outcome: nullableText,
    assets: z
      .number()
      .optional()
      .catch(0)
      .transform((value) => value ?? 0),
    error: probeError,
  }),
});

export function decodeVideoGenerationProbeEvidence(
  value: unknown,
): VideoGenerationProbeEvidence {
  return decodeTopLevel(videoGenerationProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// Main-persisted generation authority
// ---------------------------------------------------------------------------

export interface GenerationPersistenceProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  observedAt?: string | null;
  mode?: string | null;
  generationJobId?: string | null;
  attemptId?: string | null;
  attemptNo?: number;
  jobStatus?: string | null;
  attemptStatus?: string | null;
  provider?: string | null;
  profileKey?: string | null;
  profileVersion?: number | null;
  workflowKey?: string | null;
  workflowVersion?: number | null;
  terminal?: {
    ref?: string | null;
    checksum?: string | null;
    receiptId?: string | null;
    receiptState?: string | null;
    outboxState?: string | null;
    transportCount?: number;
    transportStatus?: string | null;
    artifactCount?: number;
    deliveredCount?: number;
    mediaAssetCount?: number;
  } | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const generationPersistenceProbeEvidenceSchema: z.ZodType<GenerationPersistenceProbeEvidence> =
  z.object({
    ok: flag,
    checkedAt: nullableText,
    observedAt: nullableText,
    mode: nullableText,
    generationJobId: nullableText,
    attemptId: nullableText,
    attemptNo: optionalCount,
    jobStatus: nullableText,
    attemptStatus: nullableText,
    provider: nullableText,
    profileKey: nullableText,
    profileVersion: z.number().int().positive().nullish().catch(null),
    workflowKey: nullableText,
    workflowVersion: z.number().int().positive().nullish().catch(null),
    terminal: nullableObject({
      ref: nullableText,
      checksum: nullableText,
      receiptId: nullableText,
      receiptState: nullableText,
      outboxState: nullableText,
      transportCount: optionalCount,
      transportStatus: nullableText,
      artifactCount: optionalCount,
      deliveredCount: optionalCount,
      mediaAssetCount: optionalCount,
    }),
    error: probeError,
  });

function decodeGenerationPersistenceProbeEvidence(value: unknown) {
  return decodeTopLevel(generationPersistenceProbeEvidenceSchema, value);
}

export function decodeImageGenerationPersistenceProbeEvidence(value: unknown) {
  return decodeGenerationPersistenceProbeEvidence(value);
}

export function decodeVideoGenerationPersistenceProbeEvidence(value: unknown) {
  return decodeGenerationPersistenceProbeEvidence(value);
}

// ---------------------------------------------------------------------------
// blob storage
// ---------------------------------------------------------------------------

export interface BlobStorageProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  key?: string;
  bytes?: number;
  /** 请求体的 content-type；生产端一直在写，判定不读。 */
  contentType?: string;
  /** 写入内容的期望摘要；生产端一直在写，判定不读。 */
  sha256?: string;
  /** 对象存储配置不合法时的原因，只在配置失败路径出现。 */
  configurationError?: string;
  loadError?: string;
  put?: {
    ok?: boolean;
    size?: number;
    error?: ProbeErrorEvidence | null;
  } | null;
  signedGetUrl?: {
    ok?: boolean;
    host?: string | null;
    pathname?: string | null;
    expiresInSeconds?: number;
    error?: ProbeErrorEvidence | null;
  } | null;
  readback?: {
    ok?: boolean;
    source?: string | null;
    status?: number;
    bytes?: number;
    matches?: boolean;
    sha256?: string | null;
    error?: string | null;
  } | null;
  delete?: {
    ok?: boolean;
    error?: ProbeErrorEvidence | null;
  } | null;
}

const blobStorageProbeEvidenceSchema: z.ZodType<BlobStorageProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  endpoint: nullableText,
  bucket: nullableText,
  key: optionalText,
  bytes: optionalCount,
  put: nullableObject({ ok: flag, size: optionalCount, error: probeError }),
  signedGetUrl: nullableObject({
    ok: flag,
    host: nullableText,
    pathname: nullableText,
    expiresInSeconds: optionalCount,
    error: probeError,
  }),
  readback: nullableObject({
    ok: flag,
    source: nullableText,
    status: optionalCount,
    bytes: optionalCount,
    matches: flag,
    sha256: nullableText,
    error: nullableText,
  }),
  delete: nullableObject({ ok: flag, error: probeError }),
});

export function decodeBlobStorageProbeEvidence(value: unknown): BlobStorageProbeEvidence {
  return decodeTopLevel(blobStorageProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// safety gateway
// ---------------------------------------------------------------------------

export interface SafetyGatewayProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  serviceUrl?: string | null;
  targetType?: string | null;
  status?: string | null;
  policyCode?: string | null;
  confidence?: number;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const safetyGatewayProbeEvidenceSchema: z.ZodType<SafetyGatewayProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  serviceUrl: nullableText,
  targetType: nullableText,
  status: nullableText,
  policyCode: nullableText,
  confidence: optionalCount,
  error: probeError,
});

export function decodeSafetyGatewayProbeEvidence(value: unknown): SafetyGatewayProbeEvidence {
  return decodeTopLevel(safetyGatewayProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// chat service
// ---------------------------------------------------------------------------

export interface ChatServiceProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  serviceUrl?: string | null;
  userId?: string | null;
  actorDataClass?: string | null;
  dedicatedActor?: boolean;
  characterId?: string | null;
  characterSource?: string | null;
  usedSignedBff?: boolean;
  loadError?: string;
  health?: {
    ok?: boolean;
    status?: number;
    service?: string | null;
    error?: string | null;
  } | null;
  signedRequest?: {
    ok?: boolean;
    status?: number;
    sessionsCount?: number;
    error?: string | null;
  } | null;
  runtimeAuthority?: {
    ok?: boolean;
    status?: number;
    chatFsRootFingerprint?: string | null;
    sourceRevision?: string | null;
    error?: string | null;
  } | null;
  unsignedRequest?: {
    ok?: boolean;
    status?: number;
    error?: string | null;
  } | null;
  conversation?: {
    ok?: boolean;
    attempted?: boolean;
    preflightCleanup?: ChatProbeOperationEvidence | null;
    createSession?: ChatProbeOperationEvidence | null;
    sendMessage?: ChatProbeOperationEvidence | null;
    stream?: {
      ok?: boolean;
      status?: number;
      sawStart?: boolean;
      sawDelta?: boolean;
      sawDone?: boolean;
      error?: string | null;
    } | null;
    getSession?: {
      ok?: boolean;
      status?: number;
      assistantMessageId?: string;
      assistantSent?: boolean;
      assistantStatus?: string | null;
      derivationSettled?: boolean;
      error?: string | null;
    } | null;
    regenerateAnchor?: {
      ok?: boolean;
      status?: number;
      assistantMessageId?: string;
      originalAttempt?: number;
      regeneratedAttempt?: number;
      originalSceneVersion?: number | null;
      futureUserSceneVersion?: number | null;
      futureSceneVersion?: number | null;
      regeneratedSceneVersion?: number | null;
      error?: string | null;
    } | null;
    noMemory?: {
      ok?: boolean;
      status?: number;
      assistantMessageId?: string;
      authorityPinned?: boolean;
      relationshipUnchanged?: boolean;
      memorySourceAbsent?: boolean;
      error?: string | null;
    } | null;
    blockedInput?: {
      ok?: boolean;
      /** HTTP 状态码。 */
      status?: number;
      // SPEC: 与 status 并存不是没改完的重命名 —— status 是 HTTP 码，status_ 是回包里的审核结论。
      status_?: string | null;
      error?: string | null;
    } | null;
    cleanup?: {
      ok?: boolean;
      status?: number;
      memoryGone?: boolean;
      memoriesDeleted?: number;
      relationshipDeleted?: boolean;
      relationshipsDeleted?: number;
      relationshipsGone?: boolean;
      sessionDeleted?: boolean;
      sessionGone?: boolean;
      error?: string | null;
    } | null;
    error?: string | null;
  } | null;
  error?: ProbeErrorEvidence | null;
}

export interface ChatProbeOperationEvidence {
  ok?: boolean;
  status?: number;
  error?: string | null;
}

const chatProbeOperationShape = {
  ok: flag,
  status: optionalCount,
  error: nullableText,
};

const chatServiceProbeEvidenceSchema: z.ZodType<ChatServiceProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  serviceUrl: nullableText,
  userId: nullableText,
  actorDataClass: nullableText,
  dedicatedActor: flag,
  characterId: nullableText,
  characterSource: nullableText,
  usedSignedBff: flag,
  health: nullableObject({
    ok: flag,
    status: optionalCount,
    service: nullableText,
    error: nullableText,
  }),
  signedRequest: nullableObject({
    ok: flag,
    status: optionalCount,
    sessionsCount: optionalCount,
    error: nullableText,
  }),
  runtimeAuthority: nullableObject({
    ok: flag,
    status: optionalCount,
    chatFsRootFingerprint: nullableText,
    sourceRevision: nullableText,
    error: nullableText,
  }),
  unsignedRequest: nullableObject({
    ok: flag,
    status: optionalCount,
    error: nullableText,
  }),
  conversation: nullableObject({
    ok: flag,
    attempted: flag,
    preflightCleanup: nullableObject(chatProbeOperationShape),
    createSession: nullableObject(chatProbeOperationShape),
    sendMessage: nullableObject(chatProbeOperationShape),
    stream: nullableObject({
      ...chatProbeOperationShape,
      sawStart: flag,
      sawDelta: flag,
      sawDone: flag,
    }),
    getSession: nullableObject({
      ...chatProbeOperationShape,
      assistantMessageId: optionalText,
      assistantSent: flag,
      assistantStatus: nullableText,
      derivationSettled: flag,
    }),
    regenerateAnchor: nullableObject({
      ...chatProbeOperationShape,
      assistantMessageId: optionalText,
      originalAttempt: optionalCount,
      regeneratedAttempt: optionalCount,
      originalSceneVersion: optionalCount,
      futureUserSceneVersion: optionalCount,
      futureSceneVersion: optionalCount,
      regeneratedSceneVersion: optionalCount,
    }),
    noMemory: nullableObject({
      ...chatProbeOperationShape,
      assistantMessageId: optionalText,
      authorityPinned: flag,
      relationshipUnchanged: flag,
      memorySourceAbsent: flag,
    }),
    blockedInput: nullableObject({ ...chatProbeOperationShape, status_: nullableText }),
    cleanup: nullableObject({
      ...chatProbeOperationShape,
      relationshipDeleted: flag,
      memoryGone: flag,
      memoriesDeleted: optionalCount,
      relationshipsDeleted: optionalCount,
      relationshipsGone: flag,
      sessionDeleted: flag,
      sessionGone: flag,
    }),
    error: nullableText,
  }),
  error: probeError,
});

export function decodeChatServiceProbeEvidence(value: unknown): ChatServiceProbeEvidence {
  return decodeTopLevel(chatServiceProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// chat model
// ---------------------------------------------------------------------------

export interface ChatModelProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  chunks?: number;
  characters?: number;
  assistantPreview?: string | null;
  done?: boolean;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const chatModelProbeEvidenceSchema: z.ZodType<ChatModelProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  baseUrl: nullableText,
  model: nullableText,
  chunks: optionalCount,
  characters: optionalCount,
  assistantPreview: nullableText,
  done: flag,
  error: probeError,
});

export function decodeChatModelProbeEvidence(value: unknown): ChatModelProbeEvidence {
  return decodeTopLevel(chatModelProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// Main Admin text generation
// ---------------------------------------------------------------------------

export interface AdminTextProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  pipelineUrl?: string | null;
  model?: string | null;
  adminSourceRevision?: string | null;
  adminUrl?: string | null;
  characterId?: string | null;
  authMode?: string | null;
  correlationId?: string | null;
  requestIds?: {
    characterAssist?: string | null;
    productionDirections?: string | null;
  } | null;
  characterAssist?: {
    ok?: boolean;
    status?: number;
    adminSourceRevision?: string | null;
    descriptionCharacters?: number;
    nameIdeas?: number;
    personalityCharacters?: number;
    speakingStyleCharacters?: number;
    firstMessageCharacters?: number;
    visualBriefCharacters?: number;
    runtime?: {
      provider?: string | null;
      pipelineUrl?: string | null;
      model?: string | null;
      sourceRevision?: string | null;
    } | null;
    error?: string | null;
  } | null;
  productionDirections?: {
    ok?: boolean;
    status?: number;
    adminSourceRevision?: string | null;
    directions?: number;
    source?: string | null;
    scenePromptCharacters?: number;
    runtime?: {
      provider?: string | null;
      pipelineUrl?: string | null;
      model?: string | null;
      sourceRevision?: string | null;
    } | null;
    error?: string | null;
  } | null;
  cleanup?: {
    fixture?: string | null;
    immutableModerationAudit?: string | null;
  } | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const adminTextProbeEvidenceSchema: z.ZodType<AdminTextProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  pipelineUrl: nullableText,
  model: nullableText,
  adminSourceRevision: nullableText,
  adminUrl: nullableText,
  characterId: nullableText,
  authMode: nullableText,
  correlationId: nullableText,
  requestIds: nullableObject({
    characterAssist: nullableText,
    productionDirections: nullableText,
  }),
  characterAssist: nullableObject({
    ok: flag,
    status: optionalCount,
    adminSourceRevision: nullableText,
    descriptionCharacters: optionalCount,
    nameIdeas: optionalCount,
    personalityCharacters: optionalCount,
    speakingStyleCharacters: optionalCount,
    firstMessageCharacters: optionalCount,
    visualBriefCharacters: optionalCount,
    runtime: nullableObject({
      provider: nullableText,
      pipelineUrl: nullableText,
      model: nullableText,
      sourceRevision: nullableText,
    }),
    error: nullableText,
  }),
  productionDirections: nullableObject({
    ok: flag,
    status: optionalCount,
    adminSourceRevision: nullableText,
    directions: optionalCount,
    source: nullableText,
    scenePromptCharacters: optionalCount,
    runtime: nullableObject({
      provider: nullableText,
      pipelineUrl: nullableText,
      model: nullableText,
      sourceRevision: nullableText,
    }),
    error: nullableText,
  }),
  cleanup: nullableObject({
    fixture: nullableText,
    immutableModerationAudit: nullableText,
  }),
  error: probeError,
});

export function decodeAdminTextProbeEvidence(value: unknown): AdminTextProbeEvidence {
  return decodeTopLevel(adminTextProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// voice model
// ---------------------------------------------------------------------------

export interface VoiceModelProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  voiceId?: string | null;
  key?: string | null;
  audioDurationMs?: number;
  voiceCloningAvailable?: boolean | null;
  voiceCloneVerified?: boolean | null;
  bytes?: number;
  contentType?: string | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const voiceModelProbeEvidenceSchema: z.ZodType<VoiceModelProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  baseUrl: nullableText,
  model: nullableText,
  voiceId: nullableText,
  key: nullableText,
  voiceCloningAvailable: nullableFlag,
  voiceCloneVerified: nullableFlag,
  audioDurationMs: optionalCount,
  bytes: optionalCount,
  contentType: nullableText,
  error: probeError,
});

export function decodeVoiceModelProbeEvidence(value: unknown): VoiceModelProbeEvidence {
  return decodeTopLevel(voiceModelProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// payment provider
// ---------------------------------------------------------------------------

export interface PaymentProviderProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  storeId?: string | null;
  canViewStore?: boolean;
  returnedStoreId?: string | null;
  /** Read-only lookup of the exact invoice bound to a real product CheckoutSession. */
  canLookupInvoice?: boolean;
  /** Legacy detached-invoice smoke field; current terminal probes always leave it false. */
  canCreateInvoice?: boolean;
  invoiceId?: string | null;
  checkoutUrl?: string | null;
  invoiceAmountCents?: number;
  invoiceCurrency?: string | null;
  terminal?: {
    authorityVersion?: string | null;
    checkoutId?: string | null;
    checkoutStatus?: string | null;
    checkoutReturnPath?: string | null;
    providerInvoiceId?: string | null;
    providerInvoiceStatus?: string | null;
    providerInvoiceAdditionalStatus?: string | null;
    providerLookupVerified?: boolean;
    providerEventId?: string | null;
    providerEventType?: string | null;
    providerEventProcessedAt?: string | null;
    providerEventTargetHash?: string | null;
    providerDeliveryCount?: number;
    providerDeliveryIds?: string[];
    providerDeliveryPayloadHashes?: string[];
    replayVerified?: boolean;
    subscriptionId?: string | null;
    subscriptionStatus?: string | null;
    subscriptionEffectCount?: number;
    entitlementCount?: number;
    ledgerEntryId?: string | null;
    ledgerEntryCount?: number;
  } | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const paymentProviderProbeEvidenceSchema: z.ZodType<PaymentProviderProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  baseUrl: nullableText,
  storeId: nullableText,
  canViewStore: flag,
  returnedStoreId: nullableText,
  canLookupInvoice: flag,
  canCreateInvoice: flag,
  invoiceId: nullableText,
  checkoutUrl: nullableText,
  invoiceAmountCents: optionalCount,
  invoiceCurrency: nullableText,
  terminal: z.object({
    authorityVersion: nullableText,
    checkoutId: nullableText,
    checkoutStatus: nullableText,
    checkoutReturnPath: nullableText,
    providerInvoiceId: nullableText,
    providerInvoiceStatus: nullableText,
    providerInvoiceAdditionalStatus: nullableText,
    providerLookupVerified: flag,
    providerEventId: nullableText,
    providerEventType: nullableText,
    providerEventProcessedAt: nullableText,
    providerEventTargetHash: nullableText,
    providerDeliveryCount: optionalCount,
    providerDeliveryIds: z.array(z.string()).optional(),
    providerDeliveryPayloadHashes: z.array(z.string()).optional(),
    replayVerified: flag,
    subscriptionId: nullableText,
    subscriptionStatus: nullableText,
    subscriptionEffectCount: optionalCount,
    entitlementCount: optionalCount,
    ledgerEntryId: nullableText,
    ledgerEntryCount: optionalCount,
  }).optional().nullable(),
  error: probeError,
});

export function decodePaymentProviderProbeEvidence(value: unknown): PaymentProviderProbeEvidence {
  return decodeTopLevel(paymentProviderProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// age verification
// ---------------------------------------------------------------------------

export interface AgeVerificationProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  serviceUrl?: string | null;
  jurisdiction?: string | null;
  providerVerificationId?: string | null;
  status?: string | null;
  url?: string | null;
  terminal?: {
    authorityVersion?: string | null;
    verificationId?: string | null;
    verificationStatus?: string | null;
    verifiedAt?: string | null;
    callbackUrl?: string | null;
    linkBackUrl?: string | null;
    providerEventId?: string | null;
    providerEventType?: string | null;
    providerEventProcessedAt?: string | null;
    providerEventTargetHash?: string | null;
    providerDeliveryCount?: number;
    providerDeliveryIds?: string[];
    providerDeliveryPayloadHashes?: string[];
    providerPayloadHash?: string | null;
    verificationEffectCount?: number;
    replayVerified?: boolean;
  } | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const ageVerificationProbeEvidenceSchema: z.ZodType<AgeVerificationProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  serviceUrl: nullableText,
  jurisdiction: nullableText,
  providerVerificationId: nullableText,
  status: nullableText,
  url: nullableText,
  terminal: z.object({
    authorityVersion: nullableText,
    verificationId: nullableText,
    verificationStatus: nullableText,
    verifiedAt: nullableText,
    callbackUrl: nullableText,
    linkBackUrl: nullableText,
    providerEventId: nullableText,
    providerEventType: nullableText,
    providerEventProcessedAt: nullableText,
    providerEventTargetHash: nullableText,
    providerDeliveryCount: optionalCount,
    providerDeliveryIds: z.array(z.string()).optional(),
    providerDeliveryPayloadHashes: z.array(z.string()).optional(),
    providerPayloadHash: nullableText,
    verificationEffectCount: optionalCount,
    replayVerified: flag,
  }).optional().nullable(),
  error: probeError,
});

export function decodeAgeVerificationProbeEvidence(value: unknown): AgeVerificationProbeEvidence {
  return decodeTopLevel(ageVerificationProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// product config
// ---------------------------------------------------------------------------

export interface ProductConfigProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  videoFeatureEnabled?: boolean;
  activeImageProfiles?: number;
  activeImageExecutionBindings?: Array<{
    profileId?: string;
    runner?: string;
    model?: string;
    workflowKey?: string | null;
    workflowVersion?: number | null;
  }>;
  invalidActiveImageProfileIds?: string[];
  activeImageCharacterTemplates?: number;
  activeImageFreeplayTemplates?: number;
  activeImagePricingRules?: number;
  activeVideoProfiles?: number;
  activeVideoCharacterTemplates?: number;
  activeVideoFreeplayTemplates?: number;
  activeVideoPricingRules?: number;
  activeVoicePricingRules?: number;
  publicCharacters?: number;
  publicCharactersWithSystemPrompt?: number;
  /** 生产端算好的不达标原因；判定端目前用原始计数自行重算，不读这里。 */
  failureReasons?: string[];
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const productConfigProbeEvidenceSchema: z.ZodType<ProductConfigProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  videoFeatureEnabled: optionalFlag,
  activeImageProfiles: optionalCount,
  activeImageExecutionBindings: z
    .array(
      z.object({
        profileId: optionalText,
        runner: optionalText,
        model: optionalText,
        workflowKey: nullableText,
        workflowVersion: z
          .number()
          .nullish()
          .catch(null)
          .transform((value) => value ?? null),
      }),
    )
    .optional(),
  invalidActiveImageProfileIds: z.array(z.string()).optional(),
  activeImageCharacterTemplates: optionalCount,
  activeImageFreeplayTemplates: optionalCount,
  activeImagePricingRules: optionalCount,
  activeVideoProfiles: optionalCount,
  activeVideoCharacterTemplates: optionalCount,
  activeVideoFreeplayTemplates: optionalCount,
  activeVideoPricingRules: optionalCount,
  activeVoicePricingRules: optionalCount,
  publicCharacters: optionalCount,
  publicCharactersWithSystemPrompt: optionalCount,
  error: probeError,
});

export function decodeProductConfigProbeEvidence(value: unknown): ProductConfigProbeEvidence {
  return decodeTopLevel(productConfigProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// public catalog
// ---------------------------------------------------------------------------

export interface PublicCatalogProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  counts?: {
    publicCharacters?: number;
    publicCollections?: number;
    publicCreators?: number;
    publicFeedbackItems?: number;
    distinctImages?: number;
  } | null;
  issueTotals?: {
    total?: number;
    fail?: number;
    warn?: number;
  } | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

const publicCatalogProbeEvidenceSchema: z.ZodType<PublicCatalogProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  counts: nullableObject({
    publicCharacters: optionalCount,
    publicCollections: optionalCount,
    publicCreators: optionalCount,
    publicFeedbackItems: optionalCount,
    distinctImages: optionalCount,
  }),
  issueTotals: nullableObject({
    total: optionalCount,
    fail: optionalCount,
    warn: optionalCount,
  }),
  error: probeError,
});

export function decodePublicCatalogProbeEvidence(value: unknown): PublicCatalogProbeEvidence {
  return decodeTopLevel(publicCatalogProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// web surface
// ---------------------------------------------------------------------------

export interface WebSurfaceAssetEvidence {
  ok?: boolean;
  checked?: number;
  failures?: readonly {
    url?: string;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    error?: string;
  }[];
}

export interface WebSurfaceProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  mainUrl?: string | null;
  adminUrl?: string | null;
  loadError?: string;
  home?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    containsBrand?: boolean;
    nextErrorShell?: boolean;
    assets?: WebSurfaceAssetEvidence | null;
    error?: string | null;
  } | null;
  generate?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    containsGenerator?: boolean;
    nextErrorShell?: boolean;
    assets?: WebSurfaceAssetEvidence | null;
    error?: string | null;
  } | null;
  apiAgeGate?: {
    ok?: boolean;
    status?: number;
    code?: string | null;
    reason?: string | null;
    error?: string | null;
  } | null;
  admin?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    protected?: boolean;
    protectedReason?: string | null;
    nextErrorShell?: boolean;
    assets?: WebSurfaceAssetEvidence | null;
    error?: string | null;
  } | null;
  adminApi?: {
    ok?: boolean;
    status?: number;
    code?: string | null;
    error?: string | null;
  } | null;
  error?: ProbeErrorEvidence | null;
}

// INVARIANT: failures 用 Array.isArray 判、逐项 filter(isRecord)，与其它字段的 record 兜底不同：
// 非数组一律退化成空数组，数组里的非 record 元素被丢掉。
const webAssetFailureItem = z.object({
  url: optionalText,
  status: optionalCount,
  bytes: optionalCount,
  contentType: nullableText,
  error: optionalText,
});

const webAssetFailures = z
  .unknown()
  .optional()
  .transform((value) =>
    Array.isArray(value)
      ? value
          .filter(isRecordLike)
          .map((entry) => webAssetFailureItem.parse(asPlainRecord(entry)))
      : [],
  );

const webAssetEvidence = nullableObject({
  ok: flag,
  checked: optionalCount,
  failures: webAssetFailures,
});

const webPageShape = {
  ok: flag,
  status: optionalCount,
  bytes: optionalCount,
  contentType: nullableText,
  nextErrorShell: optionalFlag,
  assets: webAssetEvidence,
  error: nullableText,
};

const webSurfaceProbeEvidenceSchema: z.ZodType<WebSurfaceProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  mainUrl: nullableText,
  adminUrl: nullableText,
  home: nullableObject({ ...webPageShape, containsBrand: optionalFlag }),
  generate: nullableObject({ ...webPageShape, containsGenerator: optionalFlag }),
  apiAgeGate: nullableObject({
    ok: flag,
    status: optionalCount,
    code: nullableText,
    reason: nullableText,
    error: nullableText,
  }),
  admin: nullableObject({
    ...webPageShape,
    protected: optionalFlag,
    protectedReason: nullableText,
  }),
  adminApi: nullableObject({
    ok: flag,
    status: optionalCount,
    code: nullableText,
    error: nullableText,
  }),
  error: probeError,
});

export function decodeWebSurfaceProbeEvidence(value: unknown): WebSurfaceProbeEvidence {
  return decodeTopLevel(webSurfaceProbeEvidenceSchema, value);
}

// ---------------------------------------------------------------------------
// Sentry canary
// ---------------------------------------------------------------------------

export interface SentryCanaryProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  service?: string | null;
  emitter?: string | null;
  release?: string | null;
  correlationId?: string | null;
  eventId?: string | null;
  projectId?: string | null;
  verified?: boolean;
  verifiedAt?: string | null;
  loadError?: string;
  error?: ProbeErrorEvidence | null;
}

export const SENTRY_CANARY_SERVICES = ["main", "admin", "chat", "gen"] as const;
export type SentryCanaryService = (typeof SENTRY_CANARY_SERVICES)[number];

const sentryCanaryProbeEvidenceSchema: z.ZodType<SentryCanaryProbeEvidence> = z.object({
  ok: flag,
  checkedAt: nullableText,
  durationMs: optionalCount,
  provider: nullableText,
  service: nullableText,
  emitter: nullableText,
  release: nullableText,
  correlationId: nullableText,
  eventId: nullableText,
  projectId: nullableText,
  verified: optionalFlag,
  verifiedAt: nullableText,
  error: probeError,
});

function decodeSentryCanaryProbeEvidence(
  value: unknown,
): SentryCanaryProbeEvidence {
  return decodeTopLevel(sentryCanaryProbeEvidenceSchema, value);
}

export function decodeSentryMainCanaryProbeEvidence(value: unknown) {
  return decodeSentryCanaryProbeEvidence(value);
}

export function decodeSentryAdminCanaryProbeEvidence(value: unknown) {
  return decodeSentryCanaryProbeEvidence(value);
}

export function decodeSentryChatCanaryProbeEvidence(value: unknown) {
  return decodeSentryCanaryProbeEvidence(value);
}

export function decodeSentryGenCanaryProbeEvidence(value: unknown) {
  return decodeSentryCanaryProbeEvidence(value);
}
