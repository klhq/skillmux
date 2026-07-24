import { resolve } from "node:path";

interface ResolveProjectDirectoryOptions {
  cwd?: string;
  findGitRoot?: (cwd: string) => string | null;
}

function findGitRoot(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const root = result.stdout.toString().trim();
  return root || null;
}

export function resolveProjectDirectory(
  explicitPath?: string,
  options: ResolveProjectDirectoryOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  if (explicitPath) return resolve(explicitPath);
  const gitRoot = (options.findGitRoot ?? findGitRoot)(cwd);
  return resolve(gitRoot ?? cwd);
}
