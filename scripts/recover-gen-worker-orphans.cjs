const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const {
  collectOwnership,
  loadGenEnvironment,
  ownershipRedisOptions,
  parsePsSnapshot,
} = require("./check-gen-image-worker-ownership.cjs");

const repoRoot = path.resolve(__dirname, "..");
const mainCwd = path.join(repoRoot, "packages/main");
const genCwd = path.join(repoRoot, "packages/gen");
const requireFromGen = createRequire(path.join(genCwd, "package.json"));
const generationQueues = [
  "ai.image.generate",
  "ai.video.generate",
  "app.generation.terminal.ingest",
  "app.ai.finalize",
];

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function groupMembers(psRows, pgid) {
  return psRows
    .filter((row) => row.pgid === pgid)
    .sort((left, right) => left.pid - right.pid)
    .map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      startedAt: row.startedAt,
      // A process command can contain provider tokens or prompts. The hash is
      // sufficient to reject PID reuse/argv drift without writing those values
      // into an operator artifact.
      commandSha256: sha256(row.command),
    }));
}

function memberDescendsFromRoot(member, rootPid, membersByPid) {
  const visited = new Set();
  let current = member;
  while (current.pid !== rootPid) {
    if (visited.has(current.pid)) return false;
    visited.add(current.pid);
    const parent = membersByPid.get(current.ppid);
    if (!parent) return false;
    current = parent;
  }
  return true;
}

function exactOrphanTarget(snapshot, mode, group) {
  const members = groupMembers(snapshot.psRows, group.pgid);
  const membersByPid = new Map(members.map((member) => [member.pid, member]));
  const root = membersByPid.get(group.rootPid);
  const runtime = membersByPid.get(group.runtimePid);
  const daemonRows = snapshot.psRows.filter((row) =>
    /^PM2 v[^:]*: God Daemon \(/.test(row.command),
  );
  const daemonPid = daemonRows.length === 1 ? daemonRows[0].pid : null;
  const valid =
    Number.isSafeInteger(group.pgid) &&
    group.pgid > 1 &&
    group.rootPid === group.pgid &&
    root?.pid === group.rootPid &&
    root.ppid === daemonPid &&
    root.startedAt === group.startedAt &&
    runtime?.pid === group.runtimePid &&
    runtime.ppid === root.pid &&
    members.length >= 2 &&
    new Set(members.map((member) => member.pid)).size === members.length &&
    members.every(
      (member) =>
        member.pgid === group.pgid &&
        memberDescendsFromRoot(member, group.rootPid, membersByPid),
    );
  return {
    valid,
    target: {
      mode,
      classification: "daemon_orphan",
      rootPid: group.rootPid,
      runtimePid: group.runtimePid,
      pgid: group.pgid,
      startedAt: group.startedAt,
      members: members.map((member) => ({
        ...member,
        role:
          member.pid === group.rootPid
            ? "tsx_wrapper"
            : member.pid === group.runtimePid
              ? `${mode}_runtime`
              : "descendant",
      })),
      action: { signal: "SIGTERM", processGroup: -group.pgid },
    },
  };
}

function normalizedOwnership(snapshot) {
  return ["image", "video"].map((mode) => ({
    mode,
    pm2Live: [...(snapshot.ownership?.[mode]?.pm2Live ?? [])].sort(
      (left, right) => left.pid - right.pid,
    ),
    groups: [...(snapshot.ownership?.[mode]?.groups ?? [])].sort(
      (left, right) => left.pgid - right.pgid,
    ),
  }));
}

function recoverySnapshotFingerprint(snapshot, targets) {
  return sha256({
    targets,
    ownership: normalizedOwnership(snapshot),
    queues: [...(snapshot.queues ?? [])].sort((left, right) =>
      left.queue.localeCompare(right.queue),
    ),
    cutover: {
      activeRequests: snapshot.cutover?.activeRequests,
      inFlightBullRows: snapshot.cutover?.inFlightBullRows,
      pendingTerminalOutboxes: snapshot.cutover?.pendingTerminalOutboxes,
    },
  });
}

function buildRecoveryPlan(first, second, options = {}) {
  const issues = new Set();
  const targetEntries = [];
  for (const mode of ["image", "video"]) {
    const groups = first.ownership?.[mode]?.groups ?? [];
    for (const group of groups) {
      if (group.classification !== "daemon_orphan") continue;
      targetEntries.push(exactOrphanTarget(first, mode, group));
    }
    if (
      groups.some((group) =>
        new Set(["external_unmanaged", "ambiguous"]).has(
          group.classification,
        ),
      )
    ) {
      issues.add("non_daemon_orphan_generation_group");
    }
  }
  const targets = targetEntries
    .map((entry) => entry.target)
    .sort((left, right) => left.pgid - right.pgid);
  if (targetEntries.some((entry) => !entry.valid)) {
    issues.add("orphan_process_group_invalid");
  }
  if (targets.length === 0) issues.add("no_daemon_orphans");

  const queueStatus = new Map(
    (first.queues ?? []).map((row) => [row.queue, row.paused]),
  );
  if (
    generationQueues.some((queue) => queueStatus.get(queue) !== true)
  ) {
    issues.add("generation_queues_not_paused");
  }
  if (
    ["image", "video"].some(
      (mode) => (first.ownership?.[mode]?.pm2Live ?? []).length > 0,
    )
  ) {
    issues.add("registered_generation_workers_live");
  }
  if (first.cutover?.activeRequests !== 0) {
    issues.add("active_generation_requests");
  }
  if (first.cutover?.inFlightBullRows !== 0) {
    issues.add("in_flight_generation_rows");
  }
  if (first.cutover?.pendingTerminalOutboxes !== 0) {
    issues.add("pending_terminal_outboxes");
  }

  const secondTargets = [];
  for (const mode of ["image", "video"]) {
    for (const group of second.ownership?.[mode]?.groups ?? []) {
      if (group.classification !== "daemon_orphan") continue;
      secondTargets.push(exactOrphanTarget(second, mode, group).target);
    }
  }
  secondTargets.sort((left, right) => left.pgid - right.pgid);
  const firstFingerprint = recoverySnapshotFingerprint(first, targets);
  const secondFingerprint = recoverySnapshotFingerprint(second, secondTargets);
  if (firstFingerprint !== secondFingerprint) {
    issues.add("ownership_snapshot_unstable");
  }

  const targetFingerprint = sha256(targets);
  const sortedIssues = [...issues].sort();
  const safeToApply = sortedIssues.length === 0;
  return {
    version: 1,
    kind: "idream.gen-worker-orphan-cleanup.v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    safeToApply,
    issues: sortedIssues,
    snapshotFingerprint: firstFingerprint,
    targetFingerprint,
    confirmation: safeToApply
      ? `terminate-gen-orphans:${targetFingerprint}`
      : null,
    preconditions: {
      queues: [...(first.queues ?? [])].sort((left, right) =>
        left.queue.localeCompare(right.queue),
      ),
      cutover: {
        activeRequests: first.cutover?.activeRequests ?? null,
        inFlightBullRows: first.cutover?.inFlightBullRows ?? null,
        pendingTerminalOutboxes:
          first.cutover?.pendingTerminalOutboxes ?? null,
      },
      registeredWorkers: normalizedOwnership(first).flatMap((entry) =>
        entry.pm2Live.map((worker) => ({ mode: entry.mode, ...worker })),
      ),
    },
    targets,
  };
}

function parseJsonObjectSuffix(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trimStart().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n").trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // bun may print a command prefix before the final JSON object.
    }
  }
  throw new Error("generation cutover checker did not return a JSON object");
}

function checkedPs(env) {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,lstart=,command="],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("ps collector failed");
  return parsePsSnapshot(result.stdout);
}

async function collectQueuePauseState(env) {
  const { Queue } = requireFromGen("bullmq");
  const redis = ownershipRedisOptions(env);
  const rows = [];
  for (const queueName of generationQueues) {
    const queue = new Queue(queueName, {
      connection: redis.connection,
      prefix: redis.prefix,
    });
    queue.on("error", () => undefined);
    try {
      rows.push({ queue: queueName, paused: await queue.isPaused() });
    } finally {
      await queue.close().catch(() => undefined);
    }
  }
  return rows;
}

function collectCutoverState(env) {
  const result = spawnSync("bun", ["run", "check:generation-cutover"], {
    cwd: mainCwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return parseJsonObjectSuffix(result.stdout);
}

async function collectRecoverySnapshot(env) {
  const [ownership, queues] = await Promise.all([
    collectOwnership(env, 0, 0, undefined, undefined, false, "quiescent"),
    collectQueuePauseState(env),
  ]);
  return {
    ownership,
    psRows: checkedPs(env),
    queues,
    cutover: collectCutoverState(env),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectStableRecoveryPlan(options = {}) {
  const env = options.env ?? loadGenEnvironment(process.env);
  const collect = options.collectSnapshot ?? collectRecoverySnapshot;
  const wait = options.sleep ?? delay;
  const first = await collect(env);
  await wait(500);
  const second = await collect(env);
  return buildRecoveryPlan(first, second);
}

function parseRecoveryCliArgs(args) {
  const action = args[0] ?? "plan";
  if (!new Set(["plan", "apply"]).has(action)) {
    throw new Error("Expected orphan recovery action: plan | apply");
  }
  const rest = args.slice(1);
  if (rest.length % 2 !== 0) {
    throw new Error("orphan recovery options must be --name value pairs");
  }
  const values = new Map();
  const allowed = new Set(["--plan-file", "--confirmation"]);
  for (let index = 0; index < rest.length; index += 2) {
    if (!allowed.has(rest[index])) {
      throw new Error(`unsupported orphan recovery option: ${rest[index]}`);
    }
    if (values.has(rest[index])) {
      throw new Error(`duplicate orphan recovery option: ${rest[index]}`);
    }
    values.set(rest[index], rest[index + 1]);
  }
  if (action === "plan" && values.size > 0) {
    throw new Error("plan is read-only and accepts no apply options");
  }
  const planFile = values.get("--plan-file") ?? null;
  const confirmation = values.get("--confirmation") ?? null;
  if (action === "apply" && !planFile) {
    throw new Error("apply requires --plan-file");
  }
  if (action === "apply" && !confirmation) {
    throw new Error("apply requires --confirmation");
  }
  return { action, planFile, confirmation };
}

function validateStoredPlan(plan, confirmation) {
  if (
    plan?.version !== 1 ||
    plan?.kind !== "idream.gen-worker-orphan-cleanup.v1" ||
    plan?.safeToApply !== true ||
    !Array.isArray(plan.targets) ||
    plan.targets.length === 0
  ) {
    throw new Error("stored orphan recovery plan is not safe to apply");
  }
  const targetFingerprint = sha256(plan.targets);
  if (targetFingerprint !== plan.targetFingerprint) {
    throw new Error("stored orphan recovery target fingerprint is invalid");
  }
  const expected = `terminate-gen-orphans:${targetFingerprint}`;
  if (plan.confirmation !== expected || confirmation !== expected) {
    throw new Error("orphan recovery confirmation does not match");
  }
}

async function verifyQuiescentRuntime(env, options = {}) {
  const collect = options.collectOwnership ?? collectOwnership;
  const wait = options.sleep ?? delay;
  let lastFingerprint = null;
  let consecutive = 0;
  let report = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    report = await collect(env, 0, 0, undefined, undefined, false, "quiescent");
    if (report.ok) {
      const fingerprint = sha256(report);
      consecutive = fingerprint === lastFingerprint ? consecutive + 1 : 1;
      lastFingerprint = fingerprint;
      if (consecutive >= 2) return report;
    } else {
      consecutive = 0;
      lastFingerprint = null;
    }
    if (attempt < 60) await wait(500);
  }
  return report ?? { ok: false, issues: ["quiescent_verification_missing"] };
}

async function applyRecoveryPlan(options) {
  validateStoredPlan(options.plan, options.confirmation);
  const fresh = await options.collectStablePlan();
  if (!fresh.safeToApply) {
    throw new Error(
      `orphan recovery preconditions changed: ${fresh.issues.join(",")}`,
    );
  }
  if (fresh.targetFingerprint !== options.plan.targetFingerprint) {
    throw new Error("orphan recovery target fingerprint changed");
  }
  const signalled = [];
  for (const target of options.plan.targets) {
    try {
      options.terminateProcessGroup(target.pgid, "SIGTERM");
      signalled.push({ pgid: target.pgid, signal: "SIGTERM" });
    } catch (error) {
      return {
        ok: false,
        queuesRemainPaused: true,
        signalled,
        error: {
          code: "signal_failed",
          pgid: target.pgid,
          cause:
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "unknown",
        },
      };
    }
  }
  const quiescent = await options.verifyQuiescent();
  return {
    ok: quiescent.ok === true,
    queuesRemainPaused: true,
    signalled,
    quiescent,
  };
}

function terminateProcessGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    throw new Error("refusing invalid process group");
  }
  process.kill(-pgid, signal);
}

async function main() {
  const cli = parseRecoveryCliArgs(process.argv.slice(2));
  const env = loadGenEnvironment(process.env);
  if (cli.action === "plan") {
    const plan = await collectStableRecoveryPlan({ env });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exitCode = plan.safeToApply ? 0 : 1;
    return;
  }

  const plan = JSON.parse(readFileSync(path.resolve(cli.planFile), "utf8"));
  const result = await applyRecoveryPlan({
    plan,
    confirmation: cli.confirmation,
    collectStablePlan: () => collectStableRecoveryPlan({ env }),
    terminateProcessGroup,
    verifyQuiescent: () => verifyQuiescentRuntime(env),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "orphan recovery failed"}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  applyRecoveryPlan,
  buildRecoveryPlan,
  collectRecoverySnapshot,
  collectStableRecoveryPlan,
  parseJsonObjectSuffix,
  parseRecoveryCliArgs,
  validateStoredPlan,
  verifyQuiescentRuntime,
};
