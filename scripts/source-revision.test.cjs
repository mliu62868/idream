const assert = require("node:assert/strict");
const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { computeSourceRevision } = require("./source-revision.cjs");

function git(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(ignoreRules = "ignored.txt\n") {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "idream-source-revision-"));
  git(repoRoot, ["init", "--quiet"]);
  git(repoRoot, ["config", "user.email", "source-revision@test.invalid"]);
  git(repoRoot, ["config", "user.name", "Source Revision Test"]);
  writeFileSync(path.join(repoRoot, ".gitignore"), ignoreRules);
  writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked\n");
  git(repoRoot, ["add", ".gitignore", "tracked.txt"]);
  git(repoRoot, ["commit", "--quiet", "-m", "fixture"]);
  return repoRoot;
}

test("source revision binds tracked and untracked source contents", () => {
  const repoRoot = fixture();
  const baseline = computeSourceRevision(repoRoot);

  writeFileSync(path.join(repoRoot, "tracked.txt"), "changed\n");
  assert.notEqual(computeSourceRevision(repoRoot), baseline);

  writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked\n");
  assert.equal(computeSourceRevision(repoRoot), baseline);

  writeFileSync(path.join(repoRoot, "untracked.txt"), "new source\n");
  assert.notEqual(computeSourceRevision(repoRoot), baseline);
});

test("source revision excludes ignored runtime data and binds executable mode", () => {
  const repoRoot = fixture();
  const baseline = computeSourceRevision(repoRoot);

  writeFileSync(path.join(repoRoot, "ignored.txt"), "secret or runtime evidence\n");
  assert.equal(computeSourceRevision(repoRoot), baseline);

  chmodSync(path.join(repoRoot, "tracked.txt"), 0o755);
  assert.notEqual(computeSourceRevision(repoRoot), baseline);
});

test("source revision excludes generated Fish Audio voice registry entries", () => {
  const ignoreRules = readFileSync(
    path.resolve(__dirname, "../.gitignore"),
    "utf8",
  );
  const repoRoot = fixture(ignoreRules);
  const baseline = computeSourceRevision(repoRoot);
  const voiceDirectory = path.join(repoRoot, ".data/fish-audio/voices");
  mkdirSync(voiceDirectory, { recursive: true });
  writeFileSync(path.join(voiceDirectory, "runtime-voice.wav"), "runtime voice\n");
  writeFileSync(path.join(voiceDirectory, "runtime-voice.json"), "{}\n");

  assert.equal(computeSourceRevision(repoRoot), baseline);
});

test("source revision binds symlink targets", () => {
  const repoRoot = fixture();
  symlinkSync("tracked.txt", path.join(repoRoot, "source-link"));
  const first = computeSourceRevision(repoRoot);
  unlinkSync(path.join(repoRoot, "source-link"));
  symlinkSync(".gitignore", path.join(repoRoot, "source-link"));
  assert.notEqual(computeSourceRevision(repoRoot), first);
});
