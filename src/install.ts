import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type ScanFinding, readTextFileOrNull, scanContent } from "./scan";
import { decodeUtf8Strict, listSupportingFiles, parseSkillMd } from "./vault";

export interface RepoSource {
  url: string;
  skillPath?: string;
}

const GIT_URL_PREFIXES = ["http://", "https://", "git://", "ssh://", "file://"];
const SCP_LIKE_URL_PATTERN = /^[^/\s]+@[^/\s]+:/;

export function isGitUrl(repo: string): boolean {
  if (GIT_URL_PREFIXES.some((prefix) => repo.startsWith(prefix))) return true;
  // scp-like syntax (user@host:path) has no URL scheme, so whatever accepts it here
  // hands the raw string to `git clone`/`git ls-remote` as a bare positional argument.
  // If that string starts with `-`, git's own option parser reads it as a flag, not a
  // repository — verified against git 2.55: `--upload-pack=<cmd>@host:path` makes git
  // run `<cmd>` as a real local shell command instead of contacting a remote. Reject
  // it outright rather than let a crafted string reach that argv slot.
  return SCP_LIKE_URL_PATTERN.test(repo) && !repo.startsWith("-");
}

/** A `file://` source_url reaches the local filesystem directly, not just a network
 *  remote. That's fine when the user typed it themselves at `skillmux install` time,
 *  but a `.skillmux-origin` sidecar is vault content — readable and writable by
 *  whatever populated the vault (a shared git-backed vault pulled in, or a hand-edit),
 *  same threat model as every other vault-content read this codebase guards. `skillmux
 *  outdated`/`update` must not blindly git-clone/ls-remote whatever local path a
 *  forged sidecar names. */
export function isLocalFileUrl(url: string): boolean {
  return url.startsWith("file://");
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

function extractHost(url: string): string {
  const scpMatch = url.match(/^[^/\s]+@([^/\s]+):/);
  if (scpMatch) return scpMatch[1];
  return new URL(url).hostname;
}

export function assertHostAllowed(url: string, allowedHosts: string[] | undefined): void {
  if (!allowedHosts || allowedHosts.length === 0) return;
  if (isLocalFileUrl(url)) return;
  const host = extractHost(url);
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host.toLowerCase())) {
    throw new Error(`refusing to fetch from host "${host}" — not in [egress] allowed_hosts`);
  }
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

export function resolveCloneCommit(cloneDir: string): string {
  const proc = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${cloneDir}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

export async function remoteHeadCommit(url: string, ref = "HEAD"): Promise<string> {
  const proc = Bun.spawn(["git", "ls-remote", url, ref], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ls-remote failed for ${url}: ${stderr.trim()}`);
  }
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) throw new Error(`git ls-remote returned no ref "${ref}" for ${url}`);
  const sha = line.split("\t")[0]?.trim();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`git ls-remote returned an unparseable SHA for ${url}: ${line}`);
  }
  return sha;
}

/** Recursively finds symlinks under `dir` (skipping `.git`), without following them.
 *  A skill's content must be regular files only — a symlink here is how a malicious
 *  skill smuggles an escape out of the vault once `skillmux sync` exposes it inside
 *  an agent's native skill directory. `dir` itself is checked too: a `skill_path`
 *  can point straight at a directory that git committed *as a symlink* (git supports
 *  storing symlink blobs) — walking its descendants alone would silently resolve
 *  through it and report the target's real files as clean. */
export function findSymlinks(dir: string): string[] {
  const found: string[] = [];
  if (lstatSync(dir).isSymbolicLink()) {
    return ["(the skill directory itself is a symlink)"];
  }
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(relative(dir, abs));
      } else if (entry.isDirectory()) {
        walk(abs);
      }
    }
  };
  walk(dir);
  return found.sort();
}

export interface ValidationResult {
  findings: ScanFinding[];
}

export async function validateSkillCandidate(skillId: string, dir: string): Promise<ValidationResult> {
  const symlinks = findSymlinks(dir);
  if (symlinks.length > 0) {
    throw new Error(
      `"${skillId}" contains symlink(s), which are not allowed in skill content: ${symlinks.join(", ")}`,
    );
  }

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
  const symlinks = findSymlinks(sourceDir);
  if (symlinks.length > 0) {
    throw new Error(
      `refusing to install "${skillId}": source contains symlink(s), which are not allowed in skill content: ${symlinks.join(", ")}`,
    );
  }
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

/** The returned skillId is joined straight into vaultPath by installIntoVault's callers
 *  and fed to a real rmSync(recursive)+cpSync overwrite. Both branches below can produce
 *  "." or ".." for a crafted-but-plausible input: `skill_path` of "." (e.g. `skillmux
 *  install owner/repo/.`) survives the ".." segment check since "." isn't "..", and its
 *  basename is "." too; `fallbackName` comes from deriveRepoName(url), which can return
 *  ".." for a url whose last "/"- or ":"-delimited segment is literally "..". Verified
 *  end-to-end against the real CLI binary: the former makes `install --force` wipe the
 *  entire vault, the latter makes it wipe the vault's parent directory. Neither can ever
 *  legitimately be a skill id, so reject both outright rather than let them reach a join. */
function rejectTraversalSkillId(skillId: string): void {
  if (skillId === "." || skillId === "..") {
    throw new Error(`invalid skill id "${skillId}"`);
  }
}

export function resolveSkillDir(cloneDir: string, fallbackName: string, skillPath?: string): ResolvedSkillDir {
  if (skillPath) {
    if (skillPath.startsWith("/") || skillPath.split("/").includes("..")) {
      throw new Error(`invalid skill_path "${skillPath}": must be a relative path within the repo`);
    }
    const skillId = basename(skillPath);
    rejectTraversalSkillId(skillId);
    return { skillId, dir: join(cloneDir, skillPath) };
  }
  if (existsSync(join(cloneDir, "SKILL.md"))) {
    rejectTraversalSkillId(fallbackName);
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
