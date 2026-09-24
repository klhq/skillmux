import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "./init-agents";

const TABLE_HEADER = /^\s*\[/;
const AGENTS_KEY = /^\s*agents\s*=/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Returns config.toml text with its top-level `agents` set to `agents`, leaving
 * every other line, comments included, exactly as written. config.toml is
 * often hand-maintained or rendered by a dotfiles manager, so a full
 * parse-and-reserialize would throw away what its owner wrote around the key.
 */
export function renderConfigAgents(text: string, agents: readonly AgentId[]): string {
  const line = `agents = [${agents.map((agent) => JSON.stringify(agent)).join(", ")}]`;
  const lines = text.length === 0 ? [] : text.split("\n");
  const firstTable = lines.findIndex((candidate) => TABLE_HEADER.test(candidate));
  const topEnd = firstTable === -1 ? lines.length : firstTable;

  const existing = lines.slice(0, topEnd).findIndex((candidate) => AGENTS_KEY.test(candidate));
  if (existing !== -1) {
    let end = existing;
    while (end < topEnd - 1 && !lines[end]!.includes("]")) end++;
    lines.splice(existing, end - existing + 1, line);
  } else {
    let insertAt = topEnd;
    while (insertAt > 0 && BLANK_OR_COMMENT.test(lines[insertAt - 1]!)) insertAt--;
    const needsGap = firstTable !== -1 && insertAt === topEnd;
    lines.splice(insertAt, 0, ...(needsGap ? [line, ""] : [line]));
  }

  let next = lines.join("\n");
  if (!next.endsWith("\n")) next += "\n";
  const parsed = Bun.TOML.parse(next) as { agents?: unknown };
  if (!Array.isArray(parsed.agents) || !sameAgents(parsed.agents as string[], agents)) {
    throw new Error(
      "could not update agents in config.toml automatically; set the top-level agents = [...] by hand",
    );
  }
  return next;
}

export interface ConfigAgentsWrite {
  path: string;
  previous: string | null;
  changed: boolean;
}

export function writeConfigAgents(configPath: string, agents: readonly AgentId[]): ConfigAgentsWrite {
  const previous = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const next = renderConfigAgents(previous ?? "", agents);
  if (next === previous) return { path: configPath, previous, changed: false };

  const mode = previous === null ? 0o600 : statSync(configPath).mode;
  mkdirSync(dirname(configPath), { recursive: true });
  const temporaryPath = join(dirname(configPath), `.config-agents-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, next, { encoding: "utf8", mode });
    renameSync(temporaryPath, configPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return { path: configPath, previous, changed: true };
}

export function rollbackConfigAgents(write: ConfigAgentsWrite): void {
  if (!write.changed) return;
  if (write.previous === null) rmSync(write.path, { force: true });
  else writeFileSync(write.path, write.previous, "utf8");
}
