import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function readSkillOrigin(dir: string): SkillOrigin | null {
  const path = join(dir, SKILLMUX_ORIGIN_FILENAME);
  if (!existsSync(path)) return null;
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
 *  file listSupportingFiles returns), used for local-drift detection. */
export function hashSkillContent(dir: string): string {
  const vaultPath = dirname(dir);
  const skillId = basename(dir);
  const hasher = new Bun.CryptoHasher("sha256");
  const files = ["SKILL.md", ...listSupportingFiles(vaultPath, skillId)];
  for (const rel of files) {
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(readFileSync(join(dir, rel)));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}
