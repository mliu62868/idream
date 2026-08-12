/* eslint-disable @typescript-eslint/no-require-imports -- This Node bootstrap must load Next's CommonJS CLI in the same process after Prisma generation. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const prismaCli = require.resolve("prisma/build/index.js", {
  paths: [packageRoot],
});
const nextCli = require.resolve("next/dist/bin/next", {
  paths: [packageRoot],
});

function runDevelopment(options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const runtime = options.process ?? process;
  const loadNext = options.loadNext ?? ((entrypoint) => require(entrypoint));
  const generated = spawn(runtime.execPath, [prismaCli, "generate"], {
    cwd: packageRoot,
    env: runtime.env,
    stdio: "inherit",
  });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) return generated.status ?? 1;

  // INVARIANT: production builds own .next. A source-backed dev server must
  // never read or write that directory while an immutable release is built.
  runtime.env.IDREAM_NEXT_DEVELOPMENT = "1";
  runtime.env.IDREAM_NEXT_DIST_DIR = ".next-development";

  // INVARIANT: Next must load only after Prisma Client matches the checked-out
  // schema. Turbopack does not reliably evict a Client already loaded from
  // node_modules when schema.prisma changes during a dev process.
  runtime.argv = [runtime.execPath, nextCli, "dev", ...runtime.argv.slice(2)];
  loadNext(nextCli);
  return 0;
}

if (require.main === module) {
  process.exitCode = runDevelopment();
}

module.exports = {
  nextCli,
  packageRoot,
  prismaCli,
  runDevelopment,
};
