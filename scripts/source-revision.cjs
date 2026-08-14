const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readlinkSync, realpathSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE_REVISION_FORMAT = "idream_worktree_sha256_v1";

function gitOutput(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to compute source revision: ${String(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

function sourcePaths(repoRoot) {
  const output = gitOutput(repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => {
      try {
        return !lstatSync(path.join(repoRoot, relativePath)).isDirectory();
      } catch (error) {
        if (error && error.code === "ENOENT") return false;
        throw error;
      }
    })
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
}

function sourceEntry(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { mode: "120000", content: Buffer.from(readlinkSync(absolutePath)) };
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported source entry: ${relativePath}`);
  }
  return {
    mode: stat.mode & 0o111 ? "100755" : "100644",
    content: readFileSync(absolutePath),
  };
}

function appendField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
}

function computeSourceRevision(repoRoot = path.resolve(__dirname, "..")) {
  const root = realpathSync(repoRoot);
  const gitRoot = realpathSync(
    gitOutput(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim(),
  );
  if (gitRoot !== root) {
    throw new Error(`Source revision root must be the Git root: ${gitRoot}`);
  }

  const hash = createHash("sha256");
  appendField(hash, SOURCE_REVISION_FORMAT);
  for (const relativePath of sourcePaths(root)) {
    const entry = sourceEntry(root, relativePath);
    appendField(hash, relativePath);
    appendField(hash, entry.mode);
    appendField(hash, entry.content);
  }
  return `idream-worktree-${hash.digest("hex")}`;
}

if (require.main === module) {
  process.stdout.write(`${computeSourceRevision()}\n`);
}

module.exports = {
  SOURCE_REVISION_FORMAT,
  computeSourceRevision,
};
