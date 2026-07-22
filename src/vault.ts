import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,127}$/;

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

export async function readSkill(vaultPath: string, skillId: string): Promise<VaultSkill> {
  const bytes = await Bun.file(join(vaultPath, skillId, "SKILL.md")).bytes();
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

/** Relative paths of everything under the skill dir except SKILL.md itself, sorted. */
export function listSupportingFiles(vaultPath: string, skillId: string): string[] {
  const root = join(vaultPath, skillId);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (statSync(abs).isFile()) {
        const rel = relative(root, abs);
        if (rel !== "SKILL.md") files.push(rel);
      }
    }
  };
  walk(root);
  return files.sort();
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
