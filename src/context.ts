import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "./config";

export interface ContextRecord {
  server: string;
  token_env?: string;
}

export interface ContextConfig {
  default_context: string;
  contexts: Record<string, ContextRecord>;
}

export type ResolvedTarget =
  | { type: "local"; name: "local" }
  | { type: "remote"; name: string; server: string; token_env?: string };

export const DEFAULT_CONTEXTS_PATH = "~/.config/skillmux/contexts.toml";

export async function loadContextConfig(filePath?: string): Promise<ContextConfig> {
  const targetPath = expandHome(filePath ?? DEFAULT_CONTEXTS_PATH);
  const base: ContextConfig = {
    default_context: "local",
    contexts: { local: { server: "local" } },
  };

  if (!existsSync(targetPath)) {
    return base;
  }

  try {
    const text = await Bun.file(targetPath).text();
    const parsed = Bun.TOML.parse(text) as Partial<ContextConfig>;
    const default_context = typeof parsed.default_context === "string" ? parsed.default_context : "local";
    const contexts: Record<string, ContextRecord> = { local: { server: "local" } };

    if (parsed.contexts && typeof parsed.contexts === "object") {
      for (const [name, rec] of Object.entries(parsed.contexts)) {
        if (name === "local") continue;
        if (rec && typeof rec === "object" && typeof (rec as ContextRecord).server === "string") {
          contexts[name] = {
            server: (rec as ContextRecord).server,
            ...(typeof (rec as ContextRecord).token_env === "string" ? { token_env: (rec as ContextRecord).token_env } : {}),
          };
        }
      }
    }

    return { default_context, contexts };
  } catch {
    return base;
  }
}

export async function saveContextConfig(config: ContextConfig, filePath?: string): Promise<void> {
  const targetPath = expandHome(filePath ?? DEFAULT_CONTEXTS_PATH);
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  // Serialize to TOML
  let tomlStr = `default_context = "${config.default_context}"\n\n[contexts]\n`;
  for (const [name, rec] of Object.entries(config.contexts)) {
    if (name === "local") {
      tomlStr += `[contexts.local]\nserver = "local"\n\n`;
      continue;
    }
    tomlStr += `[contexts.${name}]\nserver = "${rec.server}"\n`;
    if (rec.token_env) {
      tomlStr += `token_env = "${rec.token_env}"\n`;
    }
    tomlStr += `\n`;
  }

  const tmpPath = join(dir, `.contexts-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpPath, tomlStr, "utf-8");
  renameSync(tmpPath, targetPath);
}

export async function listContexts(filePath?: string): Promise<Array<{ name: string; server: string; token_env?: string; isDefault: boolean }>> {
  const config = await loadContextConfig(filePath);
  return Object.entries(config.contexts).map(([name, rec]) => ({
    name,
    server: rec.server,
    token_env: rec.token_env,
    isDefault: name === config.default_context,
  }));
}

export async function getCurrentContext(filePath?: string): Promise<{ name: string; server: string; token_env?: string }> {
  const config = await loadContextConfig(filePath);
  const name = config.contexts[config.default_context] ? config.default_context : "local";
  const rec = config.contexts[name] ?? { server: "local" };
  return { name, server: rec.server, token_env: rec.token_env };
}

export async function addContext(name: string, record: ContextRecord, filePath?: string): Promise<void> {
  if (name === "local") {
    throw new Error('Context "local" is reserved and cannot be added or modified');
  }
  const config = await loadContextConfig(filePath);
  config.contexts[name] = record;
  await saveContextConfig(config, filePath);
}

export async function removeContext(name: string, filePath?: string): Promise<void> {
  if (name === "local") {
    throw new Error('Context "local" is reserved and cannot be removed');
  }
  const config = await loadContextConfig(filePath);
  if (!config.contexts[name]) {
    throw new Error(`Context "${name}" does not exist`);
  }
  delete config.contexts[name];
  if (config.default_context === name) {
    config.default_context = "local";
  }
  await saveContextConfig(config, filePath);
}

export async function useContext(name: string, filePath?: string): Promise<void> {
  const config = await loadContextConfig(filePath);
  if (!config.contexts[name]) {
    throw new Error(`Context "${name}" does not exist`);
  }
  config.default_context = name;
  await saveContextConfig(config, filePath);
}

export async function resolveTarget(
  flags: { context?: string; server?: string },
  filePath?: string
): Promise<ResolvedTarget> {
  // Precedence 1: Explicit flags
  if (flags.context && flags.server) {
    throw new Error("Cannot specify both --context and --server");
  }
  if (flags.context) {
    if (flags.context === "local") return { type: "local", name: "local" };
    const config = await loadContextConfig(filePath);
    const rec = config.contexts[flags.context];
    if (!rec) {
      throw new Error(`Specified context "${flags.context}" does not exist`);
    }
    if (rec.server === "local") return { type: "local", name: "local" };
    return { type: "remote", name: flags.context, server: rec.server, token_env: rec.token_env };
  }
  if (flags.server) {
    if (flags.server === "local") return { type: "local", name: "local" };
    return { type: "remote", name: "custom", server: flags.server };
  }

  // Precedence 2: Environment variables
  const envContext = process.env.SKILLMUX_CONTEXT;
  const envServer = process.env.SKILLMUX_SERVER;
  if (envContext && envServer) {
    throw new Error("Cannot specify both SKILLMUX_CONTEXT and SKILLMUX_SERVER");
  }
  if (envContext) {
    if (envContext === "local") return { type: "local", name: "local" };
    const config = await loadContextConfig(filePath);
    const rec = config.contexts[envContext];
    if (!rec) {
      throw new Error(`Configured SKILLMUX_CONTEXT "${envContext}" does not exist`);
    }
    if (rec.server === "local") return { type: "local", name: "local" };
    return { type: "remote", name: envContext, server: rec.server, token_env: rec.token_env };
  }
  if (envServer) {
    if (envServer === "local") return { type: "local", name: "local" };
    return { type: "remote", name: "custom", server: envServer };
  }

  // Precedence 3 & 4: Configured default context -> local
  const config = await loadContextConfig(filePath);
  const defName = config.contexts[config.default_context] ? config.default_context : "local";
  const defRec = config.contexts[defName] ?? { server: "local" };

  if (defName === "local" || defRec.server === "local") {
    return { type: "local", name: "local" };
  }
  return { type: "remote", name: defName, server: defRec.server, token_env: defRec.token_env };
}
