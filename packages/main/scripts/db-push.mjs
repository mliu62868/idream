import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture
      ? ["pipe", "pipe", "pipe"]
      : options.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
    input: options.input,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

run("prisma", ["db", "push"]);
run("prisma", ["generate"]);
