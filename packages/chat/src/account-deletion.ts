// SPEC: Chat owns no product rows. Account deletion erases only local AgentRun,
// boundary and DSH workspace bytes, then synchronously commits that evidence to Main.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACCOUNT_ERASURE_COMPLETION_V2_INGEST_PATH,
  CHAT_TO_MAIN_EVENTS,
  MAIN_TO_CHAT_EVENTS,
  accountDeletionRequestedV2PayloadSchema,
  durableAckSchema,
  durableEnvelopeHash,
  durableEventEnvelopeSchema,
} from "@idream/shared/contracts";
import {
  fenceAgentRunsForUser,
  purgeAgentRunsForUser,
} from "./agent-run-store.js";
import { cancelAgentRunsForUser } from "./agent-runner.js";
import { purgeCompanionWorkspace } from "./agent-runtime/runtime.js";
import { env } from "./env.js";

interface LocalDeletionReceipt {
  version: 1;
  requestHash: string;
  completionEventId: string;
  fileMutationId: string;
  purgedAt: string;
  deliveredAt: string | null;
}

export async function consumeAccountDeletionRequest(raw: unknown) {
  const event = durableEventEnvelopeSchema.parse(raw);
  const payload = accountDeletionRequestedV2PayloadSchema.parse(event.payload);
  if (
    event.sourceService !== "main"
    || event.eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2
    || event.schemaVersion !== 2
    || event.aggregateType !== "user"
    || event.aggregateId !== payload.userId
  ) {
    throw new Error("invalid account deletion v2 durable envelope");
  }

  const requestHash = durableEnvelopeHash(event);
  const completionEventId = `chat_account_erasure_v2_${sha256(event.sourceEventId).slice(0, 40)}`;
  const fileMutationId = `local_account_delete_${sha256(`${payload.userId}:${event.sourceEventId}`).slice(0, 40)}`;
  const receiptFile = localReceiptFile(event.sourceEventId);
  const existing = await readReceipt(receiptFile);
  if (existing && (
    existing.requestHash !== requestHash
    || existing.completionEventId !== completionEventId
    || existing.fileMutationId !== fileMutationId
  )) {
    throw new Error("account deletion request identity was reused with different authority");
  }

  // INVARIANT: retries repeat every idempotent purge before Main advances.
  // Fence new admission, then wait for every in-process writer before removing
  // its files. Otherwise a cancelled model callback could recreate a purged
  // proposal or attempt workspace after Main accepted erasure completion.
  await fenceAgentRunsForUser(payload.userId);
  await cancelAgentRunsForUser(payload.userId);
  await purgeAgentRunsForUser(payload.userId);
  await purgeCompanionWorkspace({ scope: "user", userId: payload.userId });
  await purgeRetiredUserFiles(payload.userId);

  const receipt: LocalDeletionReceipt = existing ?? {
    version: 1,
    requestHash,
    completionEventId,
    fileMutationId,
    purgedAt: new Date().toISOString(),
    deliveredAt: null,
  };
  await atomicWrite(receiptFile, receipt);

  const completion = durableEventEnvelopeSchema.parse({
    sourceService: "chat",
    sourceEventId: completionEventId,
    eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
    schemaVersion: 2,
    occurredAt: receipt.purgedAt,
    aggregateType: "user",
    aggregateId: payload.userId,
    payload: {
      version: 2,
      binding: "request_bound",
      userId: payload.userId,
      fileMutationId,
      deletionRequestEventId: event.sourceEventId,
    },
  });
  const response = await fetch(
    `${env.MAIN_INTERNAL_BASE_URL}${ACCOUNT_ERASURE_COMPLETION_V2_INGEST_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": env.INTERNAL_TOKEN,
      },
      body: JSON.stringify(completion),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Main account erasure completion returned HTTP ${response.status}`);
  }
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged) throw new Error("Main did not acknowledge account erasure completion");

  await atomicWrite(receiptFile, { ...receipt, deliveredAt: new Date().toISOString() });
  return durableAckSchema.parse({
    acknowledged: true,
    status: existing ? "duplicate" : "persisted",
    receiptId: `main:${event.sourceEventId}`,
  });
}

function localReceiptFile(sourceEventId: string): string {
  return path.join(
    path.resolve(env.CHAT_FS_ROOT),
    "account-deletions",
    `${sha256(sourceEventId)}.json`,
  );
}

async function purgeRetiredUserFiles(userId: string): Promise<void> {
  if (!userId || !/^[A-Za-z0-9._:-]+$/u.test(userId) || userId.includes("..")) {
    throw new Error("unsafe retired Chat user path");
  }
  const root = path.resolve(env.CHAT_FS_ROOT);
  const target = path.resolve(root, "mem", userId);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("retired Chat user path escapes CHAT_FS_ROOT");
  await rm(target, { recursive: true, force: true });
}

async function readReceipt(file: string): Promise<LocalDeletionReceipt | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as LocalDeletionReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file: string, value: LocalDeletionReceipt): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
