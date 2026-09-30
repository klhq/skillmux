import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-vault-update-"));
  dirs.push(dir);
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A bare repo standing in for the GitHub remote, plus a working clone to push new commits from. */
export function createRemote(): { url: string; publish: (file: string, content: string) => void } {
  const root = tempDir();
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "-b", "main", bare);
  git(root, "clone", "--quiet", bare, work);
  const publish = (file: string, content: string) => {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), content);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", `add ${file}`);
    git(work, "push", "-q", "origin", "HEAD:main");
  };
  publish("first.txt", "one\n");
  return { url: `file://${bare}`, publish };
}


export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
