type ProcessEntrypointEvidence = {
  readonly argvEntry?: string;
  readonly pmExecPath?: string;
};

/**
 * INVARIANT: PM2's Bun container keeps process.argv[1] on its own wrapper and
 * exposes the actual application through pm_exec_path. Direct Bun invocations
 * use argv[1]. Either launch shape must start the business loop exactly once.
 */
export function isProcessEntrypoint(
  fileNames: readonly string[],
  evidence: ProcessEntrypointEvidence = {
    argvEntry: process.argv[1],
    pmExecPath: process.env["pm_exec_path"],
  },
): boolean {
  const expected = new Set(fileNames);
  return [evidence.argvEntry, evidence.pmExecPath].some((candidate) => {
    const normalized = candidate?.replaceAll("\\", "/") ?? "";
    return expected.has(normalized.slice(normalized.lastIndexOf("/") + 1));
  });
}
