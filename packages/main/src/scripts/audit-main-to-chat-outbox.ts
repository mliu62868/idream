// SPEC: read-only reconciliation of failed Main -> Chat durable delivery.
//
// INTENT: replay is an operator mutation, so this command never requeues an
// event and never writes Main, Chat, or Redis. It compares the immutable Main
// envelope with Chat's durable Inbox receipt and the exact receiver target.
// `--fail-on-action` makes unresolved backlog a non-zero launch-gate signal.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import {
  classifyMainToChatReplay,
  validateMainToChatOutboxEnvelope,
  type MainToChatReceiverReceipt,
  type MainToChatReceiverTarget,
  type MainToChatReplayDisposition,
} from "@/server/modules/admin-v2/chat/main-outbox-reconciliation";

type ReceiptRow = {
  source_event_id: string;
  payload_hash: string;
  event_type: string;
  status: string;
  attempts: number;
  created_at: Date;
  processed_at: Date | null;
  consumed_at: Date | null;
};

type TargetRow = {
  id: string;
  status: string;
};

type SourceOutboxRow = {
  target_id: string;
  status: string;
};

const failOnAction = process.argv.includes("--fail-on-action");
const summaryOnly = process.argv.includes("--summary");

async function main() {
  const eventTypes = Object.values(MAIN_TO_CHAT_EVENTS);
  const rows = await prisma.mainOutboxEvent.findMany({
    where: { status: "failed", eventType: { in: eventTypes } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      eventType: true,
      aggregateType: true,
      aggregateId: true,
      payload: true,
      attempts: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const validations = new Map(
    rows.map((row) => [row.id, validateMainToChatOutboxEnvelope(row)]),
  );
  const sourceEventIds = rows.map(({ id }) => id);
  const attachmentIds = unique(
    [...validations.values()]
      .filter((entry) => entry.valid && entry.target?.kind === "attachment")
      .map((entry) => entry.valid ? entry.target?.id : undefined),
  );
  const sessionIds = unique(
    [...validations.values()]
      .filter((entry) => entry.valid && entry.target?.kind === "session")
      .map((entry) => entry.valid ? entry.target?.id : undefined),
  );

  const chatDatabase = chatDatabaseUrl();
  const pool = new pg.Pool({ connectionString: chatDatabase.url, max: 1 });
  const client = await pool.connect();
  let readOnly = false;
  let receiptRows: ReceiptRow[] = [];
  let attachmentRows: TargetRow[] = [];
  let sessionRows: TargetRow[] = [];
  let sourceOutboxRows: SourceOutboxRow[] = [];
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const transaction = await client.query<{ transaction_read_only: string }>(
      "SHOW transaction_read_only",
    );
    readOnly = transaction.rows[0]?.transaction_read_only === "on";
    if (!readOnly) throw new Error("Chat audit transaction is not read-only");

    if (sourceEventIds.length > 0) {
      receiptRows = (await client.query<ReceiptRow>(
        `SELECT
           source_event_id,
           payload_hash,
           event_type,
           status,
           attempts,
           created_at,
           processed_at,
           consumed_at
         FROM chat.chat_inbox_events
         WHERE source_service = $1
           AND source_event_id = ANY($2::text[])
         ORDER BY source_event_id`,
        ["main", sourceEventIds],
      )).rows;
    }
    if (attachmentIds.length > 0) {
      attachmentRows = (await client.query<TargetRow>(
        `SELECT id, status
         FROM chat.message_attachments
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [attachmentIds],
      )).rows;
      sourceOutboxRows = (await client.query<SourceOutboxRow>(
        `SELECT payload->>'attachmentId' AS target_id, status
         FROM chat.chat_outbox_events
         WHERE payload->>'attachmentId' = ANY($1::text[])
         ORDER BY target_id`,
        [attachmentIds],
      )).rows;
    }
    if (sessionIds.length > 0) {
      sessionRows = (await client.query<TargetRow>(
        `SELECT id, status
         FROM chat.chat_sessions
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [sessionIds],
      )).rows;
    }
  } finally {
    // A rollback is deliberate even for the read-only transaction: this tool
    // cannot accidentally become a write path if a later query is added.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }

  const receipts = new Map<string, MainToChatReceiverReceipt>(
    receiptRows.map((row) => [
      row.source_event_id,
      {
        sourceEventId: row.source_event_id,
        payloadHash: row.payload_hash,
        eventType: row.event_type,
        status: row.status,
        attempts: row.attempts,
      },
    ]),
  );
  const targets = new Map<string, MainToChatReceiverTarget>([
    ...attachmentRows.map((row) => [
      `attachment:${row.id}`,
      { kind: "attachment" as const, id: row.id, status: row.status },
    ] as const),
    ...sessionRows.map((row) => [
      `session:${row.id}`,
      { kind: "session" as const, id: row.id, status: row.status },
    ] as const),
  ]);
  const sourceOutboxTargets = new Set(
    sourceOutboxRows.map(({ target_id }) => target_id),
  );

  const items = rows.map((row) => {
    const validation = validations.get(row.id)!;
    const target = validation.valid && validation.target
      ? targets.get(`${validation.target.kind}:${validation.target.id}`) ?? null
      : null;
    const assessment = classifyMainToChatReplay({
      row,
      receipt: receipts.get(row.id) ?? null,
      target,
    });
    const receipt = receipts.get(row.id) ?? null;
    return {
      id: row.id,
      eventType: row.eventType,
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastErrorMessage: errorMessage(row.lastError),
      disposition: assessment.disposition,
      envelopeHash: assessment.validation.valid
        ? assessment.validation.envelopeHash
        : null,
      target: assessment.validation.valid ? assessment.validation.target : null,
      receiver: {
        receipt: receipt
          ? {
              status: receipt.status,
              attempts: receipt.attempts,
              payloadHash: receipt.payloadHash,
            }
          : null,
        targetStatus: target?.status ?? null,
        sourceOutboxPresent:
          assessment.validation.valid &&
          assessment.validation.target?.kind === "attachment"
            ? sourceOutboxTargets.has(assessment.validation.target.id)
            : null,
      },
    };
  });
  const byDisposition = countBy(items.map(({ disposition }) => disposition));
  const replayable = items.filter(({ disposition }) => isReplayable(disposition));
  const reconcile = items.filter(({ disposition }) => !isReplayable(disposition));
  const report = {
    ok: rows.length === 0,
    mode: "read_only",
    chatDatabaseSource: chatDatabase.source,
    chatTransactionReadOnly: readOnly,
    asOf: new Date().toISOString(),
    summary: {
      failedMainToChat: rows.length,
      receiverReceipts: receiptRows.length,
      receiverTargets: attachmentRows.length + sessionRows.length,
      receiverSourceOutboxRows: sourceOutboxRows.length,
      replayable: replayable.length,
      reconciliationRequired: reconcile.length,
      byDisposition,
    },
    replayCandidates: replayable.map((item) => ({
      id: item.id,
      expectedAttempts: item.attempts,
      expectedUpdatedAt: item.updatedAt,
      envelopeHash: item.envelopeHash,
      disposition: item.disposition,
    })),
    reconciliationRequired: reconcile.map((item) => ({
      id: item.id,
      disposition: item.disposition,
      target: item.target,
      receiver: item.receiver,
    })),
    items,
  };
  process.stdout.write(`${JSON.stringify(
    summaryOnly
      ? {
          ok: report.ok,
          mode: report.mode,
          chatDatabaseSource: report.chatDatabaseSource,
          chatTransactionReadOnly: report.chatTransactionReadOnly,
          asOf: report.asOf,
          summary: report.summary,
        }
      : report,
    null,
    2,
  )}\n`);
  if (failOnAction && rows.length > 0) process.exitCode = 2;
}

function chatDatabaseUrl(): { url: string; source: string } {
  if (process.env.CHAT_DATABASE_URL?.trim()) {
    return { url: process.env.CHAT_DATABASE_URL, source: "CHAT_DATABASE_URL" };
  }
  const localEnvPath = fileURLToPath(new URL("../../../chat/.env", import.meta.url));
  if (existsSync(localEnvPath)) {
    const local = parse(readFileSync(localEnvPath));
    if (local.CHAT_DATABASE_URL?.trim()) {
      return {
        url: local.CHAT_DATABASE_URL,
        source: "packages/chat/.env:CHAT_DATABASE_URL",
      };
    }
  }
  throw new Error(
    "CHAT_DATABASE_URL is required for read-only Main to Chat receipt reconciliation",
  );
}

function isReplayable(disposition: MainToChatReplayDisposition) {
  return disposition.startsWith("replay_");
}

function unique(values: ReadonlyArray<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function countBy(values: readonly string[]) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

function errorMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
