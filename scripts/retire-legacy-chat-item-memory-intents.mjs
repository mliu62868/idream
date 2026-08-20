#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromChat = createRequire(
  new URL("../packages/chat/package.json", import.meta.url),
);
const { Pool } = requireFromChat("pg");

export const USAGE =
  "usage: retire-legacy-chat-item-memory-intents [--apply]";

export function parseArgs(argv) {
  if (argv.length === 0) return { apply: false };
  if (argv.length === 1 && argv[0] === "--apply") return { apply: true };
  throw new Error(USAGE);
}

export function companionLoopbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DSH_AGENT_URL must be a loopback HTTP URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "::1", "localhost"].includes(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("DSH_AGENT_URL must be a canonical loopback HTTP URL");
  }
  return url;
}

async function purgeUserWorkspace({ baseUrl, token, userId, fetchImpl }) {
  const response = await fetchImpl(new URL("/v1/workspaces/purge", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "user", userId }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    body.ok !== true ||
    !Number.isSafeInteger(body.purged) ||
    body.purged < 0
  ) {
    throw new Error(`companion user workspace purge failed with HTTP ${response.status}`);
  }
  return body.purged;
}

async function retireUserIntents(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`idream-chat:user:${userId}`],
    );
    const retired = await client.query(
      `UPDATE chat.chat_file_mutations
       SET status = 'applied',
           payload = chat.redact_file_mutation_payload(id, kind, payload),
           attempts = attempts + 1,
           last_error = NULL,
           applied_at = timezone('utc', now())
       WHERE user_id = $1
         AND status = 'pending'
         AND kind IN ('memory_update', 'memory_delete')
       RETURNING id`,
      [userId],
    );
    await client.query("COMMIT");
    return retired.rowCount ?? retired.rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retire an untranslatable item intent only after the entire user-scoped igrep
 * authority is gone. Replaying PostgreSQL messages here would resurrect the
 * very item whose old identity can no longer be mapped, so this migration is
 * deliberately purge-only and leaves an identity-only terminal receipt.
 */
export async function retireLegacyItemMemoryIntents({
  apply,
  connectionString,
  sidecarUrl,
  token,
  fetchImpl = fetch,
  poolFactory = (options) => new Pool(options),
}) {
  if (!connectionString?.trim()) {
    throw new Error("CHAT_PROJECTOR_DATABASE_URL is required");
  }
  const pool = poolFactory({ connectionString });
  try {
    const pending = await pool.query(
      `SELECT user_id, count(*)::integer AS intent_count
       FROM chat.chat_file_mutations
       WHERE status = 'pending'
         AND kind IN ('memory_update', 'memory_delete')
       GROUP BY user_id
       ORDER BY user_id`,
    );
    const intents = pending.rows.reduce(
      (total, row) => total + Number(row.intent_count),
      0,
    );
    if (!apply || pending.rows.length === 0) {
      return {
        schemaVersion: 1,
        ok: pending.rows.length === 0,
        mode: "check",
        users: pending.rows.length,
        intents,
        retired: 0,
        purgedWorkspaces: 0,
      };
    }
    const baseUrl = companionLoopbackUrl(sidecarUrl);
    if (!token?.trim()) throw new Error("DSH_AGENT_TOKEN is required");
    let retired = 0;
    let purgedWorkspaces = 0;
    for (const row of pending.rows) {
      purgedWorkspaces += await purgeUserWorkspace({
        baseUrl,
        token,
        userId: row.user_id,
        fetchImpl,
      });
      retired += await retireUserIntents(pool, row.user_id);
    }
    return {
      schemaVersion: 1,
      ok: retired === intents,
      mode: "apply",
      users: pending.rows.length,
      intents,
      retired,
      purgedWorkspaces,
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const report = await retireLegacyItemMemoryIntents({
    apply,
    connectionString: process.env.CHAT_PROJECTOR_DATABASE_URL,
    sidecarUrl: process.env.DSH_AGENT_URL,
    token: process.env.DSH_AGENT_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "legacy intent retirement failed"}\n`);
    process.exitCode = 1;
  });
}
