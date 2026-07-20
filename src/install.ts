import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ScanFinding, readTextFileOrNull, scanContent } from "./scan";
import { decodeUtf8Strict, listSupportingFiles, parseSkillMd } from "./vault";

export interface RepoSource {
  url: string;
  skillPath?: string;
}

const GIT_URL_PREFIXES = ["http://", "https://", "git://", "ssh://", "file://"];
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

export function deriveRepoName(url: string): string {
  const cleaned = url.replace(/\.git$/, "");
  const segment = cleaned.split(/[/:]/).filter(Boolean).pop();
  if (!segment) throw new Error(`could not derive a repo name from "${url}"`);
  return segment;
}

export async function cloneToTemp(url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-install-"));
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

export interface ValidationResult {
  findings: ScanFinding[];
}

export async function validateSkillCandidate(skillId: string, dir: string): Promise<ValidationResult> {
  const bytes = await Bun.file(join(dir, "SKILL.md")).bytes();
  const body = decodeUtf8Strict(bytes);
  parseSkillMd(skillId, body);

  const findings: ScanFinding[] = scanContent(body).map((match) => ({
    ...match,
    skill_id: skillId,
    file: "SKILL.md",
  }));

  const vaultPath = dirname(dir);
  const dirName = basename(dir);
  for (const rel of listSupportingFiles(vaultPath, dirName)) {
    const content = await readTextFileOrNull(join(dir, rel));
    if (content === null) continue;
    for (const match of scanContent(content)) {
      findings.push({ ...match, skill_id: skillId, file: rel });
    }
  }

  return { findings };
}

export function installIntoVault(vaultPath: string, skillId: string, sourceDir: string, force = false): string {
  const targetDir = join(vaultPath, skillId);
  if (existsSync(targetDir)) {
    if (!force) {
      throw new Error(`skill "${skillId}" already exists in the vault at ${targetDir} — pass --force to overwrite`);
    }
    rmSync(targetDir, { recursive: true, force: true });
  }
  cpSync(sourceDir, targetDir, { recursive: true, filter: (src) => basename(src) !== ".git" });
  return targetDir;
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
