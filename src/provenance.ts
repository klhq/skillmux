import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isGitUrl } from "./install";
import { SKILLMUX_ORIGIN_FILENAME, listSupportingFiles } from "./vault";

export { SKILLMUX_ORIGIN_FILENAME };

export interface SkillOrigin {
  schema_version: 1;
  source_url: string;
  skill_path?: string;
  commit: string;
  installed_at: string;
  content_hash: string;
}

function validateOrigin(origin: SkillOrigin, path: string): SkillOrigin {
  if (origin.schema_version !== 1) throw new Error(`${path}: unsupported .skillmux-origin schema_version`);
  if (typeof origin.source_url !== "string" || origin.source_url.length === 0) {
    throw new Error(`${path}: .skillmux-origin is missing source_url`);
  }
  if (!isGitUrl(origin.source_url)) {
    throw new Error(`${path}: .skillmux-origin has a source_url that is not a recognized git protocol`);
  }
  if (typeof origin.commit !== "string" || !/^[0-9a-f]{40}$/.test(origin.commit)) {
    throw new Error(`${path}: .skillmux-origin has an invalid commit`);
  }
  if (typeof origin.installed_at !== "string") throw new Error(`${path}: .skillmux-origin is missing installed_at`);
  if (typeof origin.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(origin.content_hash)) {
    throw new Error(`${path}: .skillmux-origin has an invalid content_hash`);
  }
  return origin;
}

/** Same defense-in-depth as readSkill/hashSkillContent: a tampered vault entry
 *  (shared git-backed vault pulled in, or a hand-edit) could symlink the sidecar
 *  itself to an arbitrary host file — refuse to follow it rather than feeding
 *  that file's bytes into JSON.parse and, on a schema-shaped coincidence, into
 *  the git commands `outdated`/`update` run against `source_url`. */
export function readSkillOrigin(dir: string): SkillOrigin | null {
  // The skill directory itself must be checked separately from the sidecar's own
  // leaf check below: `lstat` only refuses to follow the *final* path component,
  // so a symlinked skill directory containing a real, non-symlink sidecar at its
  // target would otherwise resolve straight through to arbitrary host content.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error(`${dir}: refusing to read .skillmux-origin — the skill directory is a symlink`);
  }
  const path = join(dir, SKILLMUX_ORIGIN_FILENAME);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`${path}: refusing to read .skillmux-origin — it is a symlink`);
  }
  return validateOrigin(JSON.parse(readFileSync(path, "utf-8")), path);
}

export function writeSkillOrigin(
  dir: string,
  params: {
    source_url: string;
    skill_path?: string;
    commit: string;
    installed_at: string;
    content_hash: string;
  },
): void {
  const origin: SkillOrigin = { schema_version: 1, ...params };
  writeFileSync(join(dir, SKILLMUX_ORIGIN_FILENAME), JSON.stringify(origin, null, 2));
}

/** Deterministic sha256 over every file in a skill directory (SKILL.md plus every
 *  file listSupportingFiles returns), used for local-drift detection. listSupportingFiles
 *  already excludes symlinks it finds, but SKILL.md is read separately (same reason
 *  readSkill/deliverSkill guard it independently in vault.ts/router-core.ts) — this is
 *  a local, already-installed vault dir, not the freshly cloned candidate that
 *  validateSkillCandidate has vetted, so a swapped-in symlinked SKILL.md must be
 *  refused here rather than followed. `dir` itself is checked too: every per-file
 *  lstat below only refuses to follow a symlinked *leaf*, so a symlinked `dir`
 *  containing real (non-symlink) files at its target would otherwise resolve
 *  straight through to arbitrary host content. */
export function hashSkillContent(dir: string): string {
  const vaultPath = dirname(dir);
  const skillId = basename(dir);
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`refusing to hash ${skillId}: the skill directory is a symlink`);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const files = ["SKILL.md", ...listSupportingFiles(vaultPath, skillId)];
  for (const rel of files) {
    const path = join(dir, rel);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to hash ${skillId}/${rel}: it is a symlink`);
    }
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(readFileSync(path));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}
