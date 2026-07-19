import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface RepoSource {
  url: string;
  skillPath?: string;
}

const GIT_URL_PREFIXES = ["http://", "https://", "git://", "ssh://"];
const SCP_LIKE_URL_PATTERN = /^[^/\s]+@[^/\s]+:/;

function isGitUrl(repo: string): boolean {
  return GIT_URL_PREFIXES.some((prefix) => repo.startsWith(prefix)) || SCP_LIKE_URL_PATTERN.test(repo);
}

export function resolveRepoSource(repo: string): RepoSource {
  if (isGitUrl(repo)) return { url: repo };

  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`invalid repo "${repo}": expected owner/repo, owner/repo/path, or a git URL`);
  }
  const url = `https://github.com/${owner}/${name}.git`;
  return rest.length > 0 ? { url, skillPath: rest.join("/") } : { url };
}

export async function cloneToTemp(url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "skr-install-"));
  const proc = Bun.spawn(["git", "clone", "--quiet", "--depth", "1", url, dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone failed for ${url}: ${stderr.trim()}`);
  }
  return dir;
}

export interface ResolvedSkillDir {
  skillId: string;
  dir: string;
}

export function resolveSkillDir(cloneDir: string, fallbackName: string, skillPath?: string): ResolvedSkillDir {
  if (skillPath) {
    return { skillId: basename(skillPath), dir: join(cloneDir, skillPath) };
  }
  if (existsSync(join(cloneDir, "SKILL.md"))) {
    return { skillId: fallbackName, dir: cloneDir };
  }
  const discovered = readdirSync(cloneDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cloneDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  throw new Error(
    discovered.length > 0
      ? `no SKILL.md at repo root; found skill dirs: ${discovered.join(", ")} — pass a path to select one, e.g. owner/repo/${discovered[0]}`
      : "no SKILL.md at repo root and no skill dirs found under it",
  );
}
