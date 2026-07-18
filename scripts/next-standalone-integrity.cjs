const { createHash } = require("node:crypto");
const {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} = require("node:fs");
const path = require("node:path");

function pathIsInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function visitTree(root, visit) {
  const walk = (directory) => {
    const entries = readdirSync(directory).sort();
    for (const entry of entries) {
      const absolute = path.join(directory, entry);
      const relative = path.relative(root, absolute);
      const stat = lstatSync(absolute);
      visit({ absolute, relative, stat });
      if (stat.isDirectory()) walk(absolute);
    }
  };
  walk(root);
}

function assertSelfContainedSymlinks(root) {
  const canonicalRoot = realpathSync(root);
  visitTree(root, ({ absolute, relative, stat }) => {
    if (!stat.isSymbolicLink()) return;
    const linkTarget = readlinkSync(absolute);
    if (path.isAbsolute(linkTarget)) {
      throw new Error(
        `Standalone release contains an absolute symbolic link: ${relative} -> ${linkTarget}`,
      );
    }
    const lexicalTarget = path.resolve(path.dirname(absolute), linkTarget);
    if (!pathIsInside(root, lexicalTarget)) {
      throw new Error(
        `Standalone release symbolic link escapes its root: ${relative} -> ${linkTarget}`,
      );
    }
    let canonicalTarget;
    try {
      canonicalTarget = realpathSync(absolute);
    } catch {
      throw new Error(
        `Standalone release contains a dangling symbolic link: ${relative} -> ${linkTarget}`,
      );
    }
    if (!pathIsInside(canonicalRoot, canonicalTarget)) {
      throw new Error(
        `Standalone release symbolic link resolves outside its root: ${relative} -> ${linkTarget}`,
      );
    }
  });
}

function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  visitTree(root, ({ absolute, relative, stat }) => {
    if (relative === "release.json") return;
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${readlinkSync(absolute)}\0`);
    } else if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0`);
    } else if (stat.isFile()) {
      hash.update(`F\0${relative}\0${stat.size}\0`);
      hash.update(readFileSync(absolute));
    }
  });
  return hash.digest("hex");
}

module.exports = {
  assertSelfContainedSymlinks,
  fingerprintDirectory,
  pathIsInside,
};
