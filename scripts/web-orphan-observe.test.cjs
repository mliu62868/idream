const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collect, parseProcesses, parseLsof } = require("./web-orphan-observe.cjs");

const line = (pid, ppid, pgid, command) => `${pid} ${ppid} ${pgid} 501 Sun Oct 25 05:02:19 2026 ${command}`;
const ps = [line(10, 1, 9, "node /private/path/next dev --secret=redacted"), line(11, 10, 9, "next-server"), line(12, 1, 12, "PM2 v5.4.3: God Daemon (/private/pm2)")].join("\n");
const ok = (output = "") => ({ status: 0, output, error: false });
const absent = () => ({ status: 1, output: "", error: false });
function fakeRun(command, args) {
  if (command === "ps") return ok(ps);
  if (args.includes("-iTCP:3000") && !args.includes("-a")) return ok("p11\nf13\nn*:3000\nTST=LISTEN\n");
  if (args.includes("-iTCP:3001")) return absent();
  if (args.includes("cwd")) return ok(`p${args[args.indexOf("-p") + 1]}\nfcwd\nn/private/project\n`);
  return ok("p11\nf13\nn*:3000\nTST=LISTEN\nf14\nn127.0.0.1:3000->127.0.0.1:50000\nTST=ESTABLISHED\n");
}

test("returns sanitized process metadata and parses socket states", () => {
  const parsed = parseProcesses(ps);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.processes[0].pid, 10);
  assert.match(parsed.processes[0].commandHash, /^[a-f\d]{64}$/);
  assert.equal(parsed.processes[2].pm2Daemon, true);
  assert.doesNotMatch(JSON.stringify(parsed), /secret=redacted|private\/path/);
  assert.equal(parseLsof("p11\nf13\nn*:3000\nTST=LISTEN\n").files[0].state, "LISTEN");
});

test("observes groups and sockets without claiming ownership or leaking commands", () => {
  const result = collect({ platform: "darwin", run: fakeRun });
  assert.equal(result.complete, true);
  assert.deepEqual(result.targets[0].listenerPids, [11]);
  assert.equal(result.targets[0].groups[0].members.length, 2);
  assert.deepEqual(result.targets[0].groups[0].connectionCounts, { ESTABLISHED: 1 });
  assert.equal(result.pm2Daemons.length, 1);
  assert.ok(result.limitations.includes("ownership_unknown"));
  assert.ok(result.limitations.includes("request_drain_unknown"));
  assert.doesNotMatch(JSON.stringify(result), /secret=redacted|private\/path|50000/);
});

test("fails closed for unsupported platform, missing cwd and failed port observation", () => {
  assert.deepEqual(collect({ platform: "linux" }).issues, ["unsupported_platform"]);
  const result = collect({ platform: "darwin", run(command, args) {
    if (args.includes("cwd")) return absent();
    if (args.includes("-iTCP:3001")) return { status: null, output: "", error: true };
    return fakeRun(command, args);
  } });
  assert.equal(result.complete, false);
  assert.ok(result.issues.includes("port_3001_listeners_unknown"));
  assert.ok(result.issues.includes("pid_10_cwd_unknown"));
});

test("rejects malformed evidence and changed process identities", () => {
  assert.deepEqual(parseProcesses("not a process").issues, ["unparsed_process_row"]);
  assert.deepEqual(parseLsof("f13\n").issues, ["lsof_file_without_pid"]);
  let snapshots = 0;
  const result = collect({ platform: "darwin", run(command, args) {
    if (command === "ps" && ++snapshots === 2) return ok(ps.replace("next-server", "different process"));
    return fakeRun(command, args);
  } });
  assert.equal(result.complete, false);
  assert.ok(result.issues.includes("pgid_9_changed_during_observation"));
});
