/* eslint-disable @typescript-eslint/no-require-imports -- standalone operator diagnostic */
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

// This is evidence collection only: it never establishes ownership or signals a process.
function hashCommand(command) {
  return createHash("sha256").update(command).digest("hex");
}

function parseProcesses(output) {
  const processes = [];
  const issues = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if (!match) {
      issues.push("unparsed_process_row");
      continue;
    }
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), started: match[5].replace(/\s+/g, " "), commandHash: hashCommand(match[6]), pm2Daemon: /^PM2 v\S+: God Daemon \(/.test(match[6]) });
  }
  return { processes, issues };
}

// lsof -F output has a process line, then file/name/TCP-state lines.
function parseLsof(output) {
  const files = [];
  const issues = [];
  let pid = null;
  let current = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (!/^\d+$/.test(value)) { issues.push("invalid_lsof_pid"); pid = null; } else pid = Number(value);
      current = null;
    } else if (tag === "f") {
      if (pid === null) { issues.push("lsof_file_without_pid"); continue; }
      current = { pid, fd: value, name: null, state: null };
      files.push(current);
    } else if (tag === "n") {
      if (!current) { issues.push("lsof_name_without_file"); continue; }
      current.name = value;
    } else if (tag === "T" && value.startsWith("ST=")) {
      if (!current) { issues.push("lsof_state_without_file"); continue; }
      current.state = value.slice(3);
    }
  }
  return { files, issues };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, output: result.stdout || "", error: Boolean(result.error || result.signal || (result.stderr || "").trim()) };
}

function collect(options = {}) {
  if ((options.platform || process.platform) !== "darwin") return { complete: false, issues: ["unsupported_platform"], targets: [], pm2Daemons: [] };
  const execute = options.run || run;
  const issues = [];
  const psArgs = ["-axo", "pid=,ppid=,pgid=,uid=,lstart=,command="];
  const before = execute("ps", psArgs);
  if (before.status !== 0 || before.error) issues.push("process_snapshot_unavailable");
  const parsed = parseProcesses(before.output);
  issues.push(...parsed.issues);
  const byPid = new Map(parsed.processes.map((item) => [item.pid, item]));
  const targets = [];
  for (const port of [3000, 3001]) {
    const observed = execute("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpncT"]);
    if ((observed.status !== 0 && observed.status !== 1) || observed.error) issues.push(`port_${port}_listeners_unknown`);
    const listeners = parseLsof(observed.output);
    issues.push(...listeners.issues);
    const listenerPids = [...new Set(listeners.files.filter((file) => file.state === "LISTEN").map((file) => file.pid))];
    if (observed.status === 0 && listenerPids.length === 0) issues.push(`port_${port}_listeners_unparsed`);
    const target = { port, listenerPids, groups: [] };
    for (const pid of listenerPids) {
      const listener = byPid.get(pid);
      if (!listener) { issues.push(`port_${port}_listener_process_unknown`); continue; }
      const members = parsed.processes.filter((item) => item.pgid === listener.pgid);
      if (!members.length) { issues.push(`port_${port}_members_unknown`); continue; }
      const memberEvidence = [];
      for (const member of members) {
        const cwdResult = execute("lsof", ["-nP", "-a", "-p", String(member.pid), "-d", "cwd", "-Fpn"]);
        const cwds = parseLsof(cwdResult.output);
        issues.push(...cwds.issues);
        const cwd = cwds.files.find((file) => file.pid === member.pid && file.fd === "cwd")?.name || null;
        if (cwdResult.status !== 0 || cwdResult.error || !cwd) issues.push(`pid_${member.pid}_cwd_unknown`);
        memberEvidence.push({ ...member, cwd });
      }
      const sockets = execute("lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-FpncT"]);
      const socketFiles = parseLsof(sockets.output);
      issues.push(...socketFiles.issues);
      if (sockets.status !== 0 || sockets.error || !socketFiles.files.some((file) => file.state === "LISTEN")) issues.push(`pid_${pid}_connections_unknown`);
      if (socketFiles.files.some((file) => !file.state)) issues.push(`pid_${pid}_socket_state_unknown`);
      const connectionCounts = {};
      for (const socket of socketFiles.files) if (socket.state && socket.state !== "LISTEN") connectionCounts[socket.state] = (connectionCounts[socket.state] || 0) + 1;
      target.groups.push({ pgid: listener.pgid, listenerPid: pid, members: memberEvidence, connectionCounts });
    }
    targets.push(target);
  }
  const after = execute("ps", psArgs);
  if (after.status !== 0 || after.error) issues.push("process_recheck_unavailable");
  const rechecked = parseProcesses(after.output);
  issues.push(...rechecked.issues);
  const afterByPid = new Map(rechecked.processes.map((item) => [item.pid, item]));
  for (const target of targets) for (const group of target.groups) {
    const laterMembers = rechecked.processes.filter((item) => item.pgid === group.pgid);
    const stable = group.members.length === laterMembers.length && group.members.every((member) => {
      const later = afterByPid.get(member.pid);
      return later && later.ppid === member.ppid && later.pgid === member.pgid && later.uid === member.uid && later.started === member.started && later.commandHash === member.commandHash;
    });
    if (!stable) issues.push(`pgid_${group.pgid}_changed_during_observation`);
  }
  const uniqueIssues = [...new Set(issues)];
  return { complete: uniqueIssues.length === 0, issues: uniqueIssues, targets, pm2Daemons: parsed.processes.filter((item) => item.pm2Daemon), limitations: ["observation_only", "ownership_unknown", "request_drain_unknown", "socket_visibility_and_races_unknown", "snapshot_not_authorization"] };
}

if (require.main === module) {
  const result = collect();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.complete) process.exitCode = 1;
}
module.exports = { collect, parseLsof, parseProcesses };
