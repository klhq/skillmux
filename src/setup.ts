import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SKILL_ID_PATTERN } from "./vault";

export interface VaultHealth {
  path: string;
  state: "missing" | "broken-symlink" | "not-directory" | "empty" | "ready";
  ok: boolean;
  skillCount: number;
  message: string;
}

export interface ConfigInitPlan {
  configPath: string;
  vaultPath: string;
  action: "create" | "preserve";
  content?: string;
}

export function inspectVault(path: string): VaultHealth {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        state: "missing",
        ok: false,
        skillCount: 0,
        message: `vault does not exist: ${path}`,
      };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    try {
      realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          path,
          state: "broken-symlink",
          ok: false,
          skillCount: 0,
          message: `vault is a dangling symlink: ${path}`,
        };
      }
      throw error;
    }
  }

  const resolvedStat = stat.isSymbolicLink() ? statSync(path) : stat;
  if (!resolvedStat.isDirectory()) {
    return {
      path,
      state: "not-directory",
      ok: false,
      skillCount: 0,
      message: `vault is not a directory: ${path}`,
    };
  }

  const skillCount = readdirSync(path, { withFileTypes: true }).filter(
    (entry) =>
      entry.isDirectory() &&
      SKILL_ID_PATTERN.test(entry.name) &&
      existsSync(join(path, entry.name, "SKILL.md")),
  ).length;
  if (skillCount === 0) {
    return {
      path,
      state: "empty",
      ok: false,
      skillCount,
      message: `vault contains no skill directories: ${path}`,
    };
  }

  return {
    path,
    state: "ready",
    ok: true,
    skillCount,
    message: `vault ready: ${path} (${skillCount} ${skillCount === 1 ? "skill" : "skills"})`,
  };
}

export function planConfigInit(configPath: string, vaultPath: string): ConfigInitPlan {
  if (existsSync(configPath)) {
    return { configPath, vaultPath, action: "preserve" };
  }

  const vaultHealth = inspectVault(vaultPath);
  if (!vaultHealth.ok) {
    throw new Error(vaultHealth.message);
  }

  return {
    configPath,
    vaultPath,
    action: "create",
    content: `vault_path = ${JSON.stringify(vaultPath)}\n`,
  };
}

export function applyConfigInit(plan: ConfigInitPlan): "created" | "preserved" {
  if (plan.action === "preserve" || existsSync(plan.configPath)) {
    return "preserved";
  }

  mkdirSync(dirname(plan.configPath), { recursive: true });
  const temporaryPath = join(
    dirname(plan.configPath),
    `.${basename(plan.configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  writeFileSync(temporaryPath, plan.content as string, { encoding: "utf8", mode: 0o600 });
  try {
    linkSync(temporaryPath, plan.configPath);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return "preserved";
    }
    throw error;
  } finally {
    unlinkSync(temporaryPath);
  }
}

export function rollbackConfigInit(plan: ConfigInitPlan): void {
  if (plan.action === "create") rmSync(plan.configPath, { force: true });
}
