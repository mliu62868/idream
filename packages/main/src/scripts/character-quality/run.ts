import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { prisma } from "../../server/lib/db";
import { env } from "../../server/lib/env";
import { createSessionToken } from "../../server/lib/auth";
import { resolveCharacterVoiceAuthority } from "../../server/modules/voice-defaults";
import { evaluateDshRecallEvidence, fetchAuditCompanionAttemptEvidence, productFetch, waitForProbeMemoryMaintenance } from "../../server/probe-chat-service";
import { waitForGenerationPersistence } from "../../server/probe-generation-persistence";
import { observeChatSseAcrossReconnects } from "../../server/readiness/chat-sse-probe";
import { QUALITY_CASES, assertQualityActor, QUALITY_REVIEW, QUALITY_SUITE_VERSION, QUALITY_PROMPT_VERSION, qualityPrompts, qualitySummary, qualityTextFacts, qualityTurnCheckNames, qualityVoiceContinuation, qualityVoiceUsageFacts, requireQualityChecks, requireQualityPromptVersion, requireFiveBindings, type QualityStage } from "./suite";

type RecordValue = Record<string, unknown>;
const args = process.argv.slice(2);
const command = args.shift();
const allowed = new Set(["manifest", "output", "characters", "actors", "case", "main-url", "media", "resume"]);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const key = args[index]!.replace(/^--/, "");
  if (!args[index]!.startsWith("--") || !allowed.has(key)) throw new Error(`Unknown argument ${args[index]}`);
  const boolean = key === "media" || key === "resume";
  const value = boolean ? "true" : args[++index];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${key} value`);
  options.set(key, value);
}
if (!command || command === "help" || command === "--help") {
  console.log("pin --manifest FILE [--characters ID,ID,ID,ID,ID] [--actors ID,ID,ID,ID,ID]\nrun --manifest FILE --output FILE --case navigator|photographer|social|gardener|creative [--media] [--resume]\ncleanup --output FILE\nLocal development and active audit actors only. Default: text-only. Media consumes existing audit allowance. Prior audit chats are archived and retained in history. Reports contain controlled transcripts; review before sharing.");
  process.exit(0);
}
function required(key: string) { const value = options.get(key); if (!value) throw new Error(`--${key} is required`); return path.resolve(value); }
function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function data(value: unknown) { const root = record(value); return record(root.data ?? root); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function save(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file); }
function localOnly() {
  const db = new URL(env.DATABASE_URL);
  if (env.APP_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(db.hostname)) throw new Error("Character quality evaluation is restricted to a local non-production database");
  return { host: db.hostname, port: db.port, name: db.pathname.slice(1) };
}
function source() {
  const root = path.resolve(import.meta.dirname, "../../../../..");
  return { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktreeRevision: execFileSync("node", ["scripts/source-revision.cjs"], { cwd: root, encoding: "utf8" }).trim() };
}

async function pinCharacter(characterId: string, actorId: string) {
  const pinned = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const character = await tx.character.findUniqueOrThrow({ where: { id: characterId }, include: { serving: { include: { currentRelease: true } }, currentContentVersion: true, visualProfiles: { where: { status: "active" }, orderBy: { version: "desc" }, take: 1 } } });
    const release = character.serving?.state === "live" && character.serving.currentRelease?.status === "published" ? character.serving.currentRelease : null;
    const content = release ? await tx.characterContentVersion.findUnique({ where: { id: release.characterContentVersionId } }) : character.currentContentVersion;
    const visual = release?.visualProfileId ? await tx.characterVisualProfile.findUnique({ where: { id: release.visualProfileId } }) : release ? null : character.visualProfiles[0] ?? null;
    const references = visual ? await tx.referenceSetRevision.findMany({ where: { visualProfileId: visual.id }, orderBy: { revision: "desc" }, take: 1, include: { references: { orderBy: { position: "asc" } } } }) : [];
    const reference = release?.referenceSetRevisionId ? await tx.referenceSetRevision.findUnique({ where: { id: release.referenceSetRevisionId }, include: { references: { orderBy: { position: "asc" } } } }) : references[0] ?? null;
    const assetIds = new Set<string>([character.imageAssetId, ...(Array.isArray(visual?.anchorAssetIds) ? visual.anchorAssetIds : []), ...(reference?.references.map((entry) => entry.mediaAssetId) ?? [])].filter((id): id is string => typeof id === "string"));
    const assets = await tx.mediaAsset.findMany({ where: { id: { in: [...assetIds] } }, orderBy: { id: "asc" }, select: { id: true, contentType: true, metadata: true, deletedAt: true, safetyStatus: true, visibility: true } });
    const accessible = !character.deletedAt && character.age >= 18 && (character.creatorId === actorId || (character.visibility !== "private" && character.status === "approved" && Boolean(release)));
    return {
      character: { id: character.id, name: character.name, age: character.age, gender: character.gender, style: character.style, source: character.source, visibility: character.visibility, creatorId: character.creatorId },
      release, content, visual, reference, assets,
      readiness: {
        actorCanStartChat: Boolean(accessible),
        adult: character.age >= 18,
        compiledSoul: Boolean(content && loadCharacterSoulSnapshot(content.personaSnapshot).ok),
        visualIdentityPinned: Boolean(visual && visual.version === (release?.visualProfileVersion ?? visual.version) && reference?.references.length),
        visualAnchorsPresent: assetIds.size > 0 && assets.length === assetIds.size && assets.every((asset) => !asset.deletedAt),
      },
    };
  }, { isolationLevel: "RepeatableRead" });
  const authority = await resolveCharacterVoiceAuthority({ characterId });
  const voice = { provider: authority.providerKey, voiceId: authority.voiceId, source: authority.source, settingVersion: authority.settingVersion, characterVoiceProfileVersion: authority.characterVoiceProfileVersion, delivery: authority.delivery };
  return { ...pinned, actorId, voice };
}
type Pins = Awaited<ReturnType<typeof pinCharacter>>;
type Manifest = { schemaVersion: string; promptVersion: number; database: ReturnType<typeof localOnly>; source: ReturnType<typeof source>; recordedAt: string; cases: Array<{ key: string; focus: string; characterId: string; actorId: string; fingerprint: string; pins: Pins }> };
type StageEvidence = { key: QualityStage; sessionId: string; prompt: string; idempotencyKey: string; startedAt: string; source?: ReturnType<typeof source>; assistantMessageId?: string; completedAt?: string; text?: string; elapsedMs?: number; observedElapsedMs?: number; facts?: Record<string, boolean>; evidence?: unknown };
type Report = {
  schemaVersion: string; promptVersion: number; runId: string; caseKey: string; characterId: string; fingerprint: string; actorId: string; source: ReturnType<typeof source>; database: ReturnType<typeof localOnly>; requestedMedia: boolean;
  invocations?: Array<{ startedAt: string; source: ReturnType<typeof source>; finishedSource?: ReturnType<typeof source> }>;
  sessions: Record<string, string>; archivedPriorSessions?: Array<{ sessionId: string; title: string | null }>; stages: StageEvidence[]; checks: Record<string, boolean>; media: RecordValue[]; voice?: RecordValue; voiceIntent?: { messageId: string; startedAt: string }; finishedText: boolean; finishedMedia: boolean; summary?: ReturnType<typeof qualitySummary>; review: typeof QUALITY_REVIEW; error?: string; failures?: Array<{ at: string; message: string }>; cleanup?: unknown;
};

async function main() {
  const database = localOnly();
  if (command === "pin") {
    const bindings = requireFiveBindings(options.get("characters")?.split(",") ?? QUALITY_CASES.map((scenario) => scenario.characterId));
    const cases: Manifest["cases"] = [];
    const actorIds = options.get("actors")?.split(",");
    if (actorIds && actorIds.length !== 5) throw new Error("--actors must supply exactly five audit actor IDs in case order");
    for (const [index, scenario] of bindings.entries()) { const actorId = actorIds?.[index] ?? scenario.actorId; const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, status: true, dataClass: true, deletedAt: true } }); assertQualityActor(actor, actorId); const pins = await pinCharacter(scenario.characterId, actorId); cases.push({ key: scenario.key, focus: scenario.focus, characterId: scenario.characterId, actorId, fingerprint: hash(pins), pins }); }
    const manifest: Manifest = { schemaVersion: QUALITY_SUITE_VERSION, promptVersion: QUALITY_PROMPT_VERSION, database, source: source(), recordedAt: new Date().toISOString(), cases };
    await save(required("manifest"), manifest);
    console.log(JSON.stringify(cases.map((scenario) => ({ key: scenario.key, name: scenario.pins.character.name, characterId: scenario.characterId, readiness: scenario.pins.readiness, voice: scenario.pins.voice }))));
    return;
  }
  if (command !== "run" && command !== "cleanup") throw new Error("Use pin, run or cleanup");
  const output = required("output");
  const manifest = command === "run" ? JSON.parse(await readFile(required("manifest"), "utf8")) as Manifest : null;
  const binding = manifest?.cases.find((entry) => entry.key === options.get("case"));
  const priorReport = command === "cleanup" ? JSON.parse(await readFile(output, "utf8")) as Report : null;
  const resolvedActorId = binding?.actorId ?? priorReport?.actorId;
  if (!resolvedActorId) throw new Error("Choose a valid --case or cleanup report");
  const actorId: string = resolvedActorId;
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, dataClass: true, role: true, status: true, deletedAt: true } });
  assertQualityActor(actor, actorId);
  const mainWebUrl = options.get("main-url") ?? process.env.MAIN_WEB_URL ?? "http://127.0.0.1:3000";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(mainWebUrl).hostname)) throw new Error("Main URL must be local");
  const authToken = createSessionToken();
  await prisma.session.create({ data: { token: authToken, userId: actorId, expiresAt: new Date(Date.now() + 90 * 60_000) } });
  const call = (method: string, endpoint: string, body?: unknown, idempotencyKey?: string) => productFetch({ mainWebUrl, authToken, userId: actorId, method, path: endpoint, ...(body ? { body: JSON.stringify(body) } : {}), idempotencyKey, signal: AbortSignal.timeout(60_000) });
  let report: Report | undefined;
  try {
    if (command === "cleanup") {
      report = JSON.parse(await readFile(output, "utf8")) as Report;
      if (report.actorId !== actorId || report.schemaVersion !== QUALITY_SUITE_VERSION || JSON.stringify(report.database) !== JSON.stringify(database)) throw new Error("Cleanup report does not belong to this local audit actor/database");
      const cleanup = [];
      for (const sessionId of Object.values(report.sessions)) {
        const session = await prisma.recentChat.findUnique({ where: { sessionId } });
        if (!session) { cleanup.push({ sessionId, alreadyGone: true }); continue; }
        if (session.userId !== actorId || session.characterId !== report.characterId || !session.title?.startsWith(`Quality ${report.runId}`)) throw new Error("Cleanup ownership mismatch");
        const pending = await prisma.chatTurn.count({ where: { sessionId, assistantStatus: { in: ["pending", "generating"] } } });
        if (pending) throw new Error("A Turn is still active; inspect/cancel it through the product before cleanup");
        if (!await waitForProbeMemoryMaintenance({ userId: actorId, characterId: report.characterId })) throw new Error("Pending memory maintenance must settle before cleanup");
        const response = await call("DELETE", `/api/v1/chat/sessions/${sessionId}`);
        if (!await waitForProbeMemoryMaintenance({ userId: actorId, characterId: report.characterId })) throw new Error("Cleanup memory rebuild did not settle");
        const verify = await call("GET", `/api/v1/chat/sessions/${sessionId}`);
        cleanup.push({ sessionId, status: response.status, verifyStatus: verify.status });
        if (response.status !== 200 || verify.status !== 404) throw new Error("Product session cleanup did not settle");
      }
      report.cleanup = { checkedAt: new Date().toISOString(), sessions: cleanup, note: "Session deletion uses Main memory rebuild; no relationship-wide purge or ledger deletion." };
      return;
    }
    if (!manifest || manifest.schemaVersion !== QUALITY_SUITE_VERSION || JSON.stringify(manifest.database) !== JSON.stringify(database)) throw new Error("Manifest version or local database does not match");
    requireQualityPromptVersion(manifest.promptVersion);
    const scenario = QUALITY_CASES.find((entry) => entry.key === options.get("case"));
    if (!binding || !scenario) throw new Error("Choose exactly one --case from the pinned manifest; runs are deliberately serial");
    const current = await pinCharacter(binding.characterId, actorId);
    if (hash(current) !== binding.fingerprint) throw new Error("Character/Soul/Release/visual/voice authority changed; create a new manifest and comparison run");
    if (!current.readiness.actorCanStartChat || !current.readiness.compiledSoul) throw new Error("Pinned character is not Chat-ready for the dedicated audit actor");
    const requestedMedia = options.has("media");
    if (!env.INTERNAL_TOKEN?.trim()) throw new Error("INTERNAL_TOKEN is required for Main attempt evidence before executing models");
    if (requestedMedia && !Object.values(current.readiness).every(Boolean)) throw new Error("Full experience remains incomplete: pinned visual identity/references or actor access is missing");
    if (options.has("resume")) {
      const resumed = JSON.parse(await readFile(output, "utf8")) as Report;
      requireQualityPromptVersion(resumed.promptVersion);
      if (resumed.schemaVersion !== QUALITY_SUITE_VERSION || JSON.stringify(resumed.database) !== JSON.stringify(database) || resumed.characterId !== binding.characterId || resumed.fingerprint !== binding.fingerprint || resumed.requestedMedia !== requestedMedia || resumed.actorId !== actorId || resumed.caseKey !== scenario.key) throw new Error("Resume inputs differ from the original run");
      if (resumed.cleanup) throw new Error("This run was cleaned up; begin a new comparison run");
      report = resumed;
      delete report.error;
    } else {
      try { await readFile(output); throw new Error("Output exists; use --resume to retain original idempotency keys"); } catch (error) { if (record(error).code !== "ENOENT") throw error; }
      report = { schemaVersion: QUALITY_SUITE_VERSION, promptVersion: QUALITY_PROMPT_VERSION, runId: randomUUID(), caseKey: scenario.key, characterId: binding.characterId, fingerprint: binding.fingerprint, actorId: actorId, source: source(), database, requestedMedia, sessions: {}, stages: [], checks: {}, media: [], finishedText: false, finishedMedia: false, review: QUALITY_REVIEW };
      await save(output, report);
    }
    const state = report;
    const invocationSource = source();
    state.invocations ??= [];
    state.invocations.push({ startedAt: new Date().toISOString(), source: invocationSource });
    await save(output, state);
    const prompts = qualityPrompts(scenario, state.runId);
    async function sessionFor(kind: "first" | "return") {
      if (state.sessions[kind]) return state.sessions[kind]!;
      const title = `Quality ${state.runId} ${kind}`;
      const existing = await prisma.recentChat.findUnique({ where: { activeKey: `${actorId}:${state.characterId}` } });
      if (existing && existing.title !== title) {
        if (existing.title?.startsWith("Quality ")) throw new Error("Another quality run is active for this character; finish or clean that run first");
        const activeTurns = await prisma.chatTurn.count({ where: { sessionId: existing.sessionId, assistantStatus: { in: ["pending", "generating"] } } });
        if (activeTurns) throw new Error("An existing audit conversation is still generating; stop before changing its active session");
        state.archivedPriorSessions ??= [];
        state.archivedPriorSessions.push({ sessionId: existing.sessionId, title: existing.title });
        await save(output, state);
        const archived = await call("POST", `/api/v1/chat/sessions/${existing.sessionId}/archive`);
        if (archived.status !== 200) throw new Error(`Could not preserve the prior audit chat in history: HTTP ${archived.status}`);
      }
      const response = await call("POST", "/api/v1/chat/sessions", { characterId: state.characterId, title });
      const payload = data(await response.json()); const session = record(payload.session ?? payload);
      if (response.status !== 201 || typeof session.id !== "string") throw new Error(`Session creation failed: ${response.status}`);
      state.sessions[kind] = session.id; await save(output, state);
      return session.id;
    }
    async function send(stage: QualityStage, sessionId: string) {
      let step = state.stages.find((entry) => entry.key === stage);
      if (step?.completedAt) { requireQualityChecks(state.checks, qualityTurnCheckNames(stage)); return step; }
      step ??= { key: stage, sessionId, prompt: prompts[stage], idempotencyKey: `quality:${state.runId}:${stage}`, startedAt: new Date().toISOString() };
      step.source ??= invocationSource;
      if (!state.stages.includes(step)) state.stages.push(step);
      await save(output, state);
      const response = await call("POST", `/api/v1/chat/sessions/${sessionId}/messages`, { content: step.prompt }, step.idempotencyKey);
      if (response.status !== 202) throw new Error(`${stage} admission HTTP ${response.status}: ${JSON.stringify(await response.json())}`);
      const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: step.idempotencyKey } } });
      step.assistantMessageId = turn.assistantMessageId; await save(output, state);
      const stream = await observeChatSseAcrossReconnects({ expectedAttempt: turn.attempt, timeoutMs: 360_000, open: (lastEventId) => productFetch({ mainWebUrl, authToken, userId: actorId, method: "GET", path: `/api/v1/chat/messages/${turn.assistantMessageId}/stream`, ...(lastEventId ? { query: `lastEventId=${encodeURIComponent(lastEventId)}` } : {}), signal: AbortSignal.timeout(365_000) }) });
      const terminal = await prisma.chatTurn.findUniqueOrThrow({ where: { id: turn.id }, include: { attachments: true } });
      const facts = qualityTextFacts({ stage, text: terminal.assistantContent, sentinel: prompts.sentinel });
      const dsh = terminal.assistantStatus === "sent" ? await fetchAuditCompanionAttemptEvidence({ serviceUrl: env.CHAT_SERVICE_URL ?? "", internalToken: env.INTERNAL_TOKEN ?? null, userId: actorId, sessionId, messageId: terminal.assistantMessageId, attempt: terminal.attempt, mode: "normal" }) : null;
      step.text = terminal.assistantContent; step.elapsedMs = terminal.terminalAt ? terminal.terminalAt.getTime() - Date.parse(step.startedAt) : undefined; step.observedElapsedMs = Date.now() - Date.parse(step.startedAt); step.facts = facts;
      step.evidence = { turnId: terminal.id, assistantMessageId: terminal.assistantMessageId, attempt: terminal.attempt, model: terminal.model, promptTokens: terminal.promptTokens, completionTokens: terminal.completionTokens, terminalAt: terminal.terminalAt, stream, dsh, attachments: terminal.attachments };
      state.checks[`${stage}.stream`] = stream.ok;
      state.checks[`${stage}.mainTerminal`] = terminal.assistantStatus === "sent" && terminal.terminalAt !== null;
      state.checks[`${stage}.soulPin`] = terminal.characterContentVersionId === current.content?.id && terminal.characterReleaseId === (current.release?.id ?? null);
      state.checks[`${stage}.visualPin`] = terminal.characterVisualProfileId === (current.visual?.id ?? null) && terminal.characterVisualProfileVersion === (current.visual?.version ?? null);
      state.checks[`${stage}.dshAuthority`] = dsh?.ok === true;
      state.checks[`${stage}.memoryProjection`] = dsh?.memoryOutcome === "projected";
      for (const [key, passed] of Object.entries(facts)) state.checks[`${stage}.${key}`] = passed;
      if (stage === "recall") state.checks[`${stage}.memorySource`] = evaluateDshRecallEvidence({ assistantContent: terminal.assistantContent, sentinel: prompts.sentinel, ...(dsh ? { dsh } : {}) }).memorySearchHit;
      await save(output, state);
      requireQualityChecks(state.checks, qualityTurnCheckNames(stage));
      step.completedAt = new Date().toISOString(); await save(output, state); return step;
    }
    const firstSession = await sessionFor("first");
    await send("opening", firstSession);
    await send("advance", firstSession);
    const archived = await call("POST", `/api/v1/chat/sessions/${firstSession}/archive`);
    if (archived.status !== 200) throw new Error(`Archive failed: HTTP ${archived.status}`);
    const returnSession = await sessionFor("return");
    state.checks.crossSession = returnSession !== firstSession;
    const recall = await send("recall", returnSession);
    // Resubmitting the original key simulates a lost admission response. It must
    // expose the same Main Turn, with one allowance fact and unchanged history.
    const replay = await call("POST", `/api/v1/chat/sessions/${returnSession}/messages`, { content: recall.prompt }, recall.idempotencyKey);
    const replayBody = data(await replay.json());
    const replayAssistant = record(replayBody.assistant);
    const replayId = replayBody.assistantMessageId ?? replayAssistant.id;
    const turn = await prisma.chatTurn.findUniqueOrThrow({ where: { sessionId_idempotencyKey: { sessionId: returnSession, idempotencyKey: recall.idempotencyKey } } });
    state.checks.idempotentReplay = replay.status === 202 && replayId === recall.assistantMessageId && turn.assistantMessageId === recall.assistantMessageId;
    state.checks.singleChatAllowance = await prisma.chatTurnUsageFact.count({ where: { turnId: turn.id, userId: actorId } }) === 1;
    const history = await call("GET", `/api/v1/chat/sessions/${returnSession}`);
    const historyBody = data(await history.json()); const messages = record(historyBody.session ?? historyBody).messages;
    state.checks.historyRevisit = history.status === 200 && Array.isArray(messages) && messages.some((message) => record(message).id === recall.assistantMessageId && record(message).content === recall.text);
    state.finishedText = true; await save(output, state);
    // Resume must re-observe failed media evidence below, while text failures
    // still stop before any new media request. Do not use all past checks here.
    requireQualityChecks(state.checks, [...(["opening", "advance", "recall"] as const).flatMap(qualityTurnCheckNames), "crossSession", "idempotentReplay", "singleChatAllowance", "historyRevisit"]);
    if (requestedMedia) {
      for (const stage of ["image", "edit"] as const) {
        const step = await send(stage, returnSession);
        const previous = state.media.find((item) => item.stage === stage);
        const deadline = Date.now() + 20 * 60_000;
        let attachments = await prisma.chatTurnAttachment.findMany({ where: { turn: { assistantMessageId: step.assistantMessageId } } });
        while (attachments.length && attachments.some((attachment) => !["completed", "failed"].includes(attachment.status)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attachments = await prisma.chatTurnAttachment.findMany({ where: { turn: { assistantMessageId: step.assistantMessageId } } });
        }
        if (attachments.length !== 1 || attachments[0]?.status !== "completed" || !attachments[0].mediaAssetId) throw new Error(`${stage} has no single completed delivery; full experience is incomplete`);
        const attachment = attachments[0];
        if (previous && (record(previous.attachment).generationJobId !== attachment.generationJobId || record(previous.attachment).mediaAssetId !== attachment.mediaAssetId)) throw new Error(`${stage} delivery identity changed; preserve the original evidence`);
        const job = attachment.generationJobId ? await prisma.generationJob.findUnique({ where: { id: attachment.generationJobId }, select: { id: true, status: true, provider: true, model: true, profileId: true, profileVersion: true, recipeId: true, recipeVersion: true, visualProfileId: true, visualProfileVersion: true, referenceSetRevisionId: true, referenceAssetIds: true, controls: true, costDreamcoins: true, createdAt: true, completedAt: true, sourceMeta: true } }) : null;
        const asset = await call("GET", `/api/v1/media/${attachment.mediaAssetId}/content`);
        const bytes = new Uint8Array(await asset.arrayBuffer());
        state.checks[`${stage}.mediaDelivered`] = asset.status === 200 && Boolean(asset.headers.get("content-type")?.startsWith("image/")) && bytes.length > 1000;
        const extension = asset.headers.get("content-type")?.includes("png") ? "png" : asset.headers.get("content-type")?.includes("webp") ? "webp" : "jpg";
        const assetPath = `${output}.${stage}.${extension}`;
        await writeFile(assetPath, bytes);
        const persistence = job ? await waitForGenerationPersistence(job.id) : null;
        state.checks[`${stage}.persistence`] = persistence?.ok === true;
        state.checks[`${stage}.generationIdentity`] = job?.visualProfileId === current.visual?.id && job?.visualProfileVersion === current.visual?.version;
        if (stage === "edit") state.checks.editSource = record(job?.controls).sourceImageAssetId === record(state.media.find((item) => item.stage === "image")?.attachment).mediaAssetId;
        const ledger = job ? await prisma.dreamcoinLedger.findMany({ where: { userId: actorId, sourceId: job.id }, select: { id: true, delta: true, reason: true, idempotencyKey: true } }) : [];
        state.checks[`${stage}.singleCharge`] = ledger.filter((entry) => entry.reason === "generation_spend").length === 1 && ledger.reduce((sum, entry) => sum + entry.delta, 0) === -(job?.costDreamcoins ?? 0);
        const observed = { stage, attachment, job, persistence, ledger, assetPath, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: asset.headers.get("content-type"), observedAt: new Date().toISOString(), jobWallMs: job?.completedAt ? job.completedAt.getTime() - job.createdAt.getTime() : null, deliveryObservedElapsedMs: Date.now() - Date.parse(step.startedAt) };
        if (previous) state.media[state.media.indexOf(previous)] = { ...observed, priorObservations: [...(Array.isArray(previous.priorObservations) ? previous.priorObservations : []), { observedAt: previous.observedAt ?? null, persistence: previous.persistence, ledger: previous.ledger }] };
        else state.media.push(observed);
        await save(output, state);
        requireQualityChecks(state.checks, [`${stage}.mediaDelivered`, `${stage}.persistence`, `${stage}.generationIdentity`, `${stage}.singleCharge`, ...(stage === "edit" ? ["editSource"] : [])]);
      }
      {
        const spoken = state.stages.find((entry) => entry.key === "opening")!;
        const body = { characterId: state.characterId, sessionId: spoken.sessionId, messageId: spoken.assistantMessageId, text: spoken.text, intent: "play" };
        state.voiceIntent ??= { messageId: spoken.assistantMessageId!, startedAt: new Date().toISOString() };
        await save(output, state);
        let existing = await prisma.voiceClipRequest.findUnique({ where: { userId_messageId: { userId: actorId, messageId: spoken.assistantMessageId! } } });
        const continuation = qualityVoiceContinuation(existing?.status ?? null);
        if (continuation === "submit") {
          const synthesis = await call("POST", "/api/v1/generation/voice", body);
          const synthesisBody = await synthesis.json();
          if (![200, 201].includes(synthesis.status)) throw new Error(`Voice failed ${synthesis.status}: ${JSON.stringify(synthesisBody)}`);
        } else if (continuation === "observe") {
          const deadline = Date.now() + 30_000;
          while (existing?.status === "running" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            existing = await prisma.voiceClipRequest.findUnique({ where: { id: existing.id } });
          }
          if (existing?.status !== "succeeded") throw new Error(`Original Voice request remains ${existing?.status ?? "missing"}; inspect before resuming, without another synthesis request`);
        }
        const request = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { userId_messageId: { userId: actorId, messageId: spoken.assistantMessageId! } }, include: { usageFacts: true } });
        if (request.status !== "succeeded" || !request.mediaAssetId) throw new Error("Voice request has no succeeded original delivery");
        if (state.voice && (state.voice.requestId !== request.id || state.voice.mediaAssetId !== request.mediaAssetId)) throw new Error("Voice delivery authority changed; preserve the original evidence");
        const payload = record(request.providerPayload);
        state.checks.voiceAuthority = payload.voiceId === current.voice.voiceId && payload.providerKey === current.voice.provider && payload.systemVoiceSettingVersion === current.voice.settingVersion && payload.characterVoiceProfileVersion === current.voice.characterVoiceProfileVersion;
        Object.assign(state.checks, qualityVoiceUsageFacts(request.mediaAssetId, request.usageFacts));
        requireQualityChecks(state.checks, ["voiceAuthority", "voiceSingleDelivery", "voiceSingleCharge"]);
        const replay = await call("POST", "/api/v1/generation/voice", body);
        const after = await prisma.voiceClipRequest.findUniqueOrThrow({ where: { id: request.id }, include: { usageFacts: true } });
        const sortedUsage = (facts: typeof request.usageFacts) => [...facts].sort((a, b) => a.id.localeCompare(b.id));
        state.checks.voiceReplay = replay.status === 200 && after.mediaAssetId === request.mediaAssetId && request.usageFacts.length > 0 && hash(sortedUsage(after.usageFacts)) === hash(sortedUsage(request.usageFacts));
        const asset = await call("GET", `/api/v1/media/${request.mediaAssetId}/content`);
        const bytes = new Uint8Array(await asset.arrayBuffer());
        state.checks.voiceDelivery = asset.status === 200 && Boolean(asset.headers.get("content-type")?.startsWith("audio/")) && bytes.length > 1000;
        const contentType = asset.headers.get("content-type");
        const extension = contentType?.includes("mpeg") ? "mp3" : contentType?.includes("ogg") ? "ogg" : contentType?.includes("flac") ? "flac" : contentType?.includes("webm") ? "webm" : "wav";
        const assetPath = `${output}.voice.${extension}`; await writeFile(assetPath, bytes);
        state.voice = { requestId: request.id, elapsedMs: request.completedAt ? request.completedAt.getTime() - request.createdAt.getTime() : null, deliveryObservedElapsedMs: Date.now() - Date.parse(state.voiceIntent.startedAt), text: spoken.text, provider: request.provider, providerPayload: request.providerPayload, mediaAssetId: request.mediaAssetId, usageFacts: request.usageFacts, assetPath, contentType, byteLength: bytes.length };
        await save(output, state);
        requireQualityChecks(state.checks, ["voiceAuthority", "voiceSingleDelivery", "voiceSingleCharge", "voiceReplay", "voiceDelivery"]);
      }
      state.finishedMedia = true;
    }
    state.checks.authorityUnchanged = hash(await pinCharacter(state.characterId, actorId)) === state.fingerprint;
  } catch (error) {
    if (report) { report.error = error instanceof Error ? error.message : String(error); report.failures ??= []; report.failures.push({ at: new Date().toISOString(), message: report.error }); }
    throw error;
  } finally {
    try {
      if (report) {
        const invocation = command === "run" ? report.invocations?.at(-1) : undefined;
        if (invocation) invocation.finishedSource = source();
        report.summary = qualitySummary({
          ...report,
          checks: report.checks,
          sourceRevisions: [report.source.worktreeRevision, ...(report.invocations?.flatMap((entry) => [entry.source.worktreeRevision, entry.finishedSource?.worktreeRevision ?? entry.source.worktreeRevision]) ?? [])],
        });
        await save(output, report);
      }
    } finally {
      await prisma.session.deleteMany({ where: { token: authToken, userId: actorId } });
    }
  }
  if (report) { console.log(JSON.stringify({ output, summary: report.summary, sessions: report.sessions })); if (report.summary?.execution !== "completed") process.exitCode = 1; }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
