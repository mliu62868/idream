const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyRecoveryPlan,
  buildRecoveryPlan,
  parseRecoveryCliArgs,
} = require("./recover-gen-worker-orphans.cjs");

const queuesPaused = [
  "ai.image.generate",
  "ai.video.generate",
  "app.generation.terminal.ingest",
  "app.ai.finalize",
].map((queue) => ({ queue, paused: true }));

function orphanSnapshot(overrides = {}) {
  const daemon = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    startedAt: "Tue Aug 11 06:00:00 2026",
    command: "PM2 v6.0.14: God Daemon (/tmp/.pm2)",
  };
  const wrapper = {
    pid: 200,
    ppid: 100,
    pgid: 200,
    startedAt: "Tue Aug 11 06:01:00 2026",
    command: "node /repo/packages/gen/node_modules/tsx/dist/cli.mjs",
  };
  const runtime = {
    pid: 201,
    ppid: 200,
    pgid: 200,
    startedAt: "Tue Aug 11 06:01:00 2026",
    command: "node --import tsx/loader.mjs src/image.ts",
  };
  const helper = {
    pid: 202,
    ppid: 201,
    pgid: 200,
    startedAt: "Tue Aug 11 06:01:00 2026",
    command: "esbuild --service=0.28.1 --ping",
  };
  return {
    ownership: {
      image: {
        pm2Live: [],
        groups: [
          {
            rootPid: 200,
            runtimePid: 201,
            pgid: 200,
            startedAt: wrapper.startedAt,
            classification: "daemon_orphan",
            slot: null,
          },
        ],
      },
      video: { pm2Live: [], groups: [] },
    },
    psRows: [daemon, wrapper, runtime, helper],
    queues: queuesPaused,
    cutover: {
      activeRequests: 0,
      inFlightBullRows: 0,
      pendingTerminalOutboxes: 0,
    },
    ...overrides,
  };
}

test("builds a stable, exact and confirmable orphan recovery plan", () => {
  const snapshot = orphanSnapshot();
  const plan = buildRecoveryPlan(snapshot, structuredClone(snapshot), {
    generatedAt: "2026-08-11T13:00:00.000Z",
  });

  assert.equal(plan.safeToApply, true);
  assert.deepEqual(plan.issues, []);
  assert.match(plan.targetFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    plan.confirmation,
    `terminate-gen-orphans:${plan.targetFingerprint}`,
  );
  assert.deepEqual(
    plan.targets.map((target) => ({
      mode: target.mode,
      rootPid: target.rootPid,
      runtimePid: target.runtimePid,
      pgid: target.pgid,
      memberPids: target.members.map((member) => member.pid),
    })),
    [
      {
        mode: "image",
        rootPid: 200,
        runtimePid: 201,
        pgid: 200,
        memberPids: [200, 201, 202],
      },
    ],
  );
  assert.equal("command" in plan.targets[0].members[0], false);
  assert.match(plan.targets[0].members[0].commandSha256, /^[a-f0-9]{64}$/);
});

test("refuses a plan while queues or registered Generation workers are live", () => {
  const snapshot = orphanSnapshot({
    queues: queuesPaused.map((row, index) =>
      index === 0 ? { ...row, paused: false } : row,
    ),
  });
  snapshot.ownership.image.pm2Live.push({
    pid: 300,
    pmId: 20,
    slot: 0,
    status: "online",
  });
  snapshot.ownership.image.groups.push({
    rootPid: 300,
    runtimePid: 301,
    pgid: 300,
    startedAt: "Tue Aug 11 06:02:00 2026",
    classification: "registered",
    slot: 0,
  });

  const plan = buildRecoveryPlan(snapshot, structuredClone(snapshot));

  assert.equal(plan.safeToApply, false);
  assert.equal(plan.confirmation, null);
  assert.ok(plan.issues.includes("generation_queues_not_paused"));
  assert.ok(plan.issues.includes("registered_generation_workers_live"));
});

test("refuses unstable, external or ambiguous process ownership", () => {
  const first = orphanSnapshot();
  const second = structuredClone(first);
  second.psRows.find((row) => row.pid === 202).pid = 203;
  const unstable = buildRecoveryPlan(first, second);
  assert.equal(unstable.safeToApply, false);
  assert.ok(unstable.issues.includes("ownership_snapshot_unstable"));

  const external = orphanSnapshot();
  external.ownership.video.groups.push({
    rootPid: 400,
    runtimePid: 401,
    pgid: 400,
    startedAt: "Tue Aug 11 06:03:00 2026",
    classification: "external_unmanaged",
    slot: null,
  });
  const externalPlan = buildRecoveryPlan(external, structuredClone(external));
  assert.equal(externalPlan.safeToApply, false);
  assert.ok(
    externalPlan.issues.includes("non_daemon_orphan_generation_group"),
  );
});

test("refuses active authority and malformed orphan group ancestry", () => {
  const active = orphanSnapshot({
    cutover: {
      activeRequests: 1,
      inFlightBullRows: 1,
      pendingTerminalOutboxes: 1,
    },
  });
  const activePlan = buildRecoveryPlan(active, structuredClone(active));
  assert.equal(activePlan.safeToApply, false);
  assert.ok(activePlan.issues.includes("active_generation_requests"));
  assert.ok(activePlan.issues.includes("in_flight_generation_rows"));
  assert.ok(activePlan.issues.includes("pending_terminal_outboxes"));

  const malformed = orphanSnapshot();
  malformed.psRows.find((row) => row.pid === 202).ppid = 999;
  const malformedPlan = buildRecoveryPlan(
    malformed,
    structuredClone(malformed),
  );
  assert.equal(malformedPlan.safeToApply, false);
  assert.ok(malformedPlan.issues.includes("orphan_process_group_invalid"));
});

test("apply revalidates the exact target fingerprint before SIGTERM", async () => {
  const snapshot = orphanSnapshot();
  const plan = buildRecoveryPlan(snapshot, structuredClone(snapshot));
  const signalled = [];

  const result = await applyRecoveryPlan({
    plan,
    confirmation: plan.confirmation,
    collectStablePlan: async () =>
      buildRecoveryPlan(snapshot, structuredClone(snapshot)),
    terminateProcessGroup: (pgid, signal) => signalled.push({ pgid, signal }),
    verifyQuiescent: async () => ({ ok: true, issues: [] }),
  });

  assert.deepEqual(signalled, [{ pgid: 200, signal: "SIGTERM" }]);
  assert.equal(result.ok, true);
  assert.equal(result.queuesRemainPaused, true);
});

test("apply sends no signal on confirmation mismatch or snapshot drift", async () => {
  const snapshot = orphanSnapshot();
  const plan = buildRecoveryPlan(snapshot, structuredClone(snapshot));
  const signalled = [];

  await assert.rejects(
    applyRecoveryPlan({
      plan,
      confirmation: "wrong",
      collectStablePlan: async () => plan,
      terminateProcessGroup: (pgid) => signalled.push(pgid),
      verifyQuiescent: async () => ({ ok: true, issues: [] }),
    }),
    /confirmation does not match/,
  );

  const drifted = orphanSnapshot();
  drifted.psRows.find((row) => row.pid === 202).pid = 203;
  await assert.rejects(
    applyRecoveryPlan({
      plan,
      confirmation: plan.confirmation,
      collectStablePlan: async () =>
        buildRecoveryPlan(drifted, structuredClone(drifted)),
      terminateProcessGroup: (pgid) => signalled.push(pgid),
      verifyQuiescent: async () => ({ ok: true, issues: [] }),
    }),
    /target fingerprint changed/,
  );
  assert.deepEqual(signalled, []);
});

test("apply reports a signal failure without resuming queues or hiding partial work", async () => {
  const snapshot = orphanSnapshot();
  const plan = buildRecoveryPlan(snapshot, structuredClone(snapshot));
  let verified = false;

  const result = await applyRecoveryPlan({
    plan,
    confirmation: plan.confirmation,
    collectStablePlan: async () => plan,
    terminateProcessGroup: () => {
      throw Object.assign(new Error("process disappeared"), { code: "ESRCH" });
    },
    verifyQuiescent: async () => {
      verified = true;
      return { ok: true, issues: [] };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.queuesRemainPaused, true);
  assert.deepEqual(result.signalled, []);
  assert.deepEqual(result.error, {
    code: "signal_failed",
    pgid: 200,
    cause: "ESRCH",
  });
  assert.equal(verified, false);
});

test("CLI keeps planning read-only and requires explicit apply authority", () => {
  assert.deepEqual(parseRecoveryCliArgs(["plan"]), {
    action: "plan",
    planFile: null,
    confirmation: null,
  });
  assert.deepEqual(
    parseRecoveryCliArgs([
      "apply",
      "--plan-file",
      "/secure/plan.json",
      "--confirmation",
      "terminate-gen-orphans:abc",
    ]),
    {
      action: "apply",
      planFile: "/secure/plan.json",
      confirmation: "terminate-gen-orphans:abc",
    },
  );
  assert.throws(() => parseRecoveryCliArgs(["apply"]), /--plan-file/);
  assert.throws(() => parseRecoveryCliArgs(["plan", "--confirmation", "x"]));
});
