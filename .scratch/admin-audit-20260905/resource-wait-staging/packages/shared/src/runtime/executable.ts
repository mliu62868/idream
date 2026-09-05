import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export async function resolveExecutable(
  command: string,
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  if (command.includes(path.sep)) {
    await access(command, fsConstants.X_OK);
    return command;
  }
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`${command} was not found on PATH`);
}
