/* eslint-disable @typescript-eslint/no-require-imports -- This Node bootstrap loads Next's CommonJS CLI in the same process after choosing the development artifact authority. */
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const nextCli = require.resolve("next/dist/bin/next", {
  paths: [packageRoot],
});

function runDevelopment(options = {}) {
  const runtime = options.process ?? process;
  const loadNext = options.loadNext ?? ((entrypoint) => require(entrypoint));
  const playwrightOwnsNext = Boolean(
    runtime.env.PW_RUN_ID &&
      runtime.env.IDREAM_NEXT_DIST_DIR &&
      runtime.env.IDREAM_NEXT_TSCONFIG,
  );

  // INVARIANT: ordinary source development owns .next-development. Playwright
  // owns a run-scoped distDir and tsconfig, which next.config.ts validates
  // before Next writes any artifact.
  if (!playwrightOwnsNext) {
    runtime.env.IDREAM_NEXT_DEVELOPMENT = "1";
    runtime.env.IDREAM_NEXT_DIST_DIR = ".next-development";
  }

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
  runDevelopment,
};
