const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const mode = process.argv[2];
if (mode && mode !== "production") {
  throw new Error(`Unsupported PM2 ecosystem mode: ${mode}`);
}

// The retired Pocket process used the same 8062 listener as Fish Audio. PM2
// otherwise keeps orphaned apps across ecosystem renames, so remove it before
// starting the current topology. A missing legacy process is the normal case.
spawnSync("pm2", ["delete", "pocket-tts"], {
  cwd: repoRoot,
  env: process.env,
  stdio: "ignore",
});

const started = spawnSync("pm2", ["start", "ecosystem.config.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ...(mode ? { IDREAM_PM2_MODE: mode } : {}),
  },
  stdio: "inherit",
});

if (started.error) throw started.error;
process.exitCode = started.status ?? 1;
