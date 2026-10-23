import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,127}$/;

/** Provenance sidecar filename (see provenance.ts). Kept here, not re-imported from
 *  provenance.ts, so listSupportingFiles can exclude it without a circular import. */
export const SKILLMUX_ORIGIN_FILENAME = ".skillmux-origin";

export const MAX_SUPPORTING_FILE_BYTES = 256 * 1024;

export interface VaultSkill {
  skill_id: string;
  title: string;
  description: string;
  aliases: string[];
  body: string;
  content_sha256: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

interface Frontmatter {
  name?: unknown;
  description?: unknown;
  aliases?: unknown;
}

export function parseSkillMd(skillId: string, raw: string): VaultSkill {
  let fm: Frontmatter = {};
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end === -1) throw new Error(`unterminated frontmatter in ${skillId}/SKILL.md`);
    fm = (Bun.YAML.parse(raw.slice(4, end)) ?? {}) as Frontmatter;
  }
  const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
  return {
    skill_id: skillId,
    title: typeof fm.name === "string" && fm.name.length > 0 ? fm.name : skillId,
    description: typeof fm.description === "string" ? fm.description : "",
    aliases,
    body: raw,
    content_sha256: sha256Hex(raw),
  };
}

/** Strict decode: invalid UTF-8 throws instead of silently mangling content. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** SKILL.md itself is read directly (not via listSupportingFiles, which excludes
 *  it by name) — so its own symlink-ness must be checked here. Without this, a
 *  symlinked SKILL.md reachable via a shared git-backed vault or a hand-edit would
 *  have its target's content indexed and delivered to agents as the skill body.
 *
 *  The skill directory itself must be checked too, separately from SKILL.md's own
 *  leaf check: `lstat` only refuses to follow the *final* path component, so a
 *  symlinked skill directory containing a real (non-symlink) SKILL.md file at its
 *  target silently passes the leaf check while still resolving straight through
 *  to arbitrary host content. */
export async function readSkill(vaultPath: string, skillId: string): Promise<VaultSkill> {
  const skillDir = join(vaultPath, skillId);
  if (lstatSync(skillDir).isSymbolicLink()) {
    throw new Error(`refusing to read ${skillId}: the skill directory is a symlink`);
  }
  const path = join(skillDir, "SKILL.md");
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to read ${skillId}/SKILL.md: it is a symlink`);
  }
  const bytes = await Bun.file(path).bytes();
  return parseSkillMd(skillId, decodeUtf8Strict(bytes));
}

export async function scanVault(
  vaultPath: string,
  onInvalid?: (skillId: string, error: unknown) => void,
): Promise<VaultSkill[]> {
  const skills: VaultSkill[] = [];
  for (const entry of readdirSync(vaultPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SKILL_ID_PATTERN.test(entry.name)) continue;
    try {
      skills.push(await readSkill(vaultPath, entry.name));
    } catch (error) {
      onInvalid?.(entry.name, error);
    }
  }
  return skills;
}

/** Local overlays checked first (in order), canonical vault_path is the fallback. */
export function vaultResolutionOrder(vaultPath: string, localVaultPaths: string[]): string[] {
  return [...localVaultPaths, vaultPath];
}

/** Which configured root actually backs skillId, per local-overrides-first precedence. */
export function resolveSkillRoot(skillId: string, vaultPath: string, localVaultPaths: string[]): string | null {
  for (const root of vaultResolutionOrder(vaultPath, localVaultPaths)) {
    if (existsSync(join(root, skillId, "SKILL.md"))) return root;
  }
  return null;
}

/** Scans every configured root and merges by skill_id — first-seen (per resolution order) wins. */
export async function scanVaults(
  vaultPath: string,
  localVaultPaths: string[],
  onInvalid?: (skillId: string, error: unknown) => void,
): Promise<VaultSkill[]> {
  const seen = new Set<string>();
  const merged: VaultSkill[] = [];
  for (const root of vaultResolutionOrder(vaultPath, localVaultPaths)) {
    if (!existsSync(root)) continue;
    for (const skill of await scanVault(root, onInvalid)) {
      if (seen.has(skill.skill_id)) continue;
      seen.add(skill.skill_id);
      merged.push(skill);
    }
  }
  return merged;
}

export interface ShadowedSkill {
  skill_id: string;
  winner: string;
  shadowed: string[];
}

/** skill_ids present in more than one configured root — every root after the winner is silently shadowed. */
export function findShadowedSkills(vaultPath: string, localVaultPaths: string[]): ShadowedSkill[] {
  const rootsBySkillId = new Map<string, string[]>();
  for (const root of vaultResolutionOrder(vaultPath, localVaultPaths)) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_ID_PATTERN.test(entry.name)) continue;
      if (!existsSync(join(root, entry.name, "SKILL.md"))) continue;
      const roots = rootsBySkillId.get(entry.name) ?? [];
      roots.push(root);
      rootsBySkillId.set(entry.name, roots);
    }
  }
  const shadowed: ShadowedSkill[] = [];
  for (const [skillId, roots] of rootsBySkillId) {
    if (roots.length > 1) shadowed.push({ skill_id: skillId, winner: roots[0]!, shadowed: roots.slice(1) });
  }
  return shadowed.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
}

/** Relative paths of everything under the skill dir except SKILL.md and the
 *  provenance sidecar, sorted. Symlinks are excluded rather than followed —
 *  install/sync already refuse a skill containing one, but a symlink can still
 *  reach the vault directly (a shared git-backed vault pulled in, or a hand-edit),
 *  and this function otherwise feeds skill content straight into content
 *  scanning (scan.ts) and drift hashing (provenance.ts). `skillId` must be a
 *  single path segment — not the stricter SKILL_ID_PATTERN, since scanPath's
 *  ad-hoc single-directory mode legitimately passes an arbitrary, not-yet-
 *  normalized directory name — so `..`/`.`/a path separator is rejected to
 *  keep the walk inside `vaultPath` without breaking that mode. */
export function listSupportingFiles(vaultPath: string, skillId: string): string[] {
  if (skillId === "" || skillId === "." || skillId === ".." || skillId.includes("/") || skillId.includes("\\")) {
    return [];
  }
  const root = join(vaultPath, skillId);
  // A symlinked skill directory must not be walked into: readdirSync follows a
  // symlinked path argument (unlike the entry.isSymbolicLink() check below, which
  // only applies to entries *found by* the walk), so without this a symlinked
  // `root` would return the target directory's file listing straight through.
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (statSync(abs).isFile()) {
        // Report "/"-separated paths on every platform, matching RelativePath.
        const rel = relative(root, abs).split(sep).join("/");
        if (rel !== "SKILL.md" && rel !== SKILLMUX_ORIGIN_FILENAME) files.push(rel);
      }
    }
  };
  walk(root);
  return files.sort();
}

/** Read only an allowlisted regular file; recheck components at delivery time. */
export function readSupportingFile(vaultPath: string, skillId: string, path: string, files: string[]): { bytes: Uint8Array; body: string } {
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\\") || path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("INVALID_FILE_PATH: use a canonical relative supporting-file path");
  }
  if (!files.includes(path)) throw new Error(`FILE_NOT_FOUND: '${path}' is not a listed supporting file`);

  let fd: number | undefined;
  try {
    const root = join(vaultPath, skillId);
    let current = root;
    // Keep the leaf's lstat from this walk: open() must land on this same inode,
    // so swapping a component for a symlink after the walk fails the check below.
    let expected = lstatSync(current);
    if (expected.isSymbolicLink()) throw new Error("symlink");
    for (const part of path.split("/")) {
      current = join(current, part);
      expected = lstatSync(current);
      if (expected.isSymbolicLink()) throw new Error("symlink");
    }
    const rootReal = realpathSync(root);
    const fileReal = realpathSync(current);
    const rel = relative(rootReal, fileReal);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("outside skill");
    if (!expected.isFile()) throw new Error("not a regular file");
    fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error("file changed");
    if (opened.size > MAX_SUPPORTING_FILE_BYTES) throw new Error("FILE_TOO_LARGE: supporting files must be at most 262144 bytes");
    // Read at most limit + 1 bytes even if the file grows after fstat.
    const buffer = Buffer.alloc(MAX_SUPPORTING_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SUPPORTING_FILE_BYTES) throw new Error("FILE_TOO_LARGE: supporting files must be at most 262144 bytes");
    const bytes = buffer.subarray(0, length);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("FILE_NOT_TEXT: supporting files must contain UTF-8 text");
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) {
      throw new Error("FILE_NOT_TEXT: supporting files must not contain binary control characters");
    }
    return { bytes, body };
  } catch (err) {
    if (err instanceof Error && /^(FILE_TOO_LARGE|FILE_NOT_TEXT):/.test(err.message)) throw err;
    throw new Error(`FILE_NOT_FOUND: '${path}' is unavailable or unsafe`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Identifies one vault root's indexable state from the stat of each skill
 * directory and its SKILL.md. File clocks advance in coarse steps, so a skill
 * added in the same step as the last index leaves the newest mtime unchanged;
 * the directory listing, sizes, and inodes in this fingerprint still change.
 */
export function getVaultFingerprint(vaultPath: string): string {
  let root;
  try {
    root = statSync(vaultPath);
  } catch {
    return "absent";
  }
  const parts = [`${root.mtimeMs}:${root.ino}`];
  const entries = readdirSync(vaultPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of entries) {
    const folderPath = join(vaultPath, name);
    try {
      const folder = statSync(folderPath);
      const file = statSync(join(folderPath, "SKILL.md"));
      parts.push(`${name}:${folder.mtimeMs}:${file.mtimeMs}:${file.size}:${file.ino}`);
    } catch {
      parts.push(`${name}:unreadable`);
    }
  }
  return sha256Hex(parts.join("\n"));
}

export function getVaultMaxMtime(vaultPath: string): number {
  try {
    let maxMtime = statSync(vaultPath).mtimeMs;
    const entries = readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name)) {
        try {
          const folderPath = join(vaultPath, entry.name);
          const folderMtime = statSync(folderPath).mtimeMs;
          maxMtime = Math.max(maxMtime, folderMtime);

          const fileMtime = statSync(join(folderPath, "SKILL.md")).mtimeMs;
          maxMtime = Math.max(maxMtime, fileMtime);
        } catch {
          // Ignore deleted files
        }
      }
    }
    return maxMtime;
  } catch {
    return 0;
  }
}
