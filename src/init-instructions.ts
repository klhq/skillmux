import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DISCOVERY_PARAGRAPH } from "./init";
import type { ClientId } from "./init-clients";

export const INSTRUCTION_BLOCK_START = "<!-- skillmux:discovery:start -->";
export const INSTRUCTION_BLOCK_END = "<!-- skillmux:discovery:end -->";

const MANAGED_BLOCK = [
  INSTRUCTION_BLOCK_START,
  DISCOVERY_PARAGRAPH,
  INSTRUCTION_BLOCK_END,
].join("\n");

export interface InstructionChange {
  path: string;
  clients: ClientId[];
  status: "create" | "update" | "unchanged";
  before: string | null;
  after: string;
}

export interface InstructionPlan {
  changes: InstructionChange[];
  manual: Array<{ client: ClientId; reason: string }>;
}

interface InstructionPlanOptions {
  home?: string;
  codexHome?: string;
  claudeConfigDir?: string;
  readFile?: (path: string) => string | null;
}

function instructionPath(
  client: ClientId,
  options: Required<Pick<InstructionPlanOptions, "home" | "codexHome" | "claudeConfigDir">>,
): string | undefined {
  if (client === "claude-code") return join(options.claudeConfigDir, "CLAUDE.md");
  if (client === "codex") return join(options.codexHome, "AGENTS.md");
  if (client === "gemini-cli" || client === "antigravity") {
    return join(options.home, ".gemini", "GEMINI.md");
  }
  if (client === "opencode") return join(options.home, ".config", "opencode", "AGENTS.md");
  if (client === "goose") return join(options.home, ".config", "goose", ".goosehints");
  if (client === "hermes") return join(options.home, ".hermes.md");
  return undefined;
}

function readInstructionFile(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`instruction file is a symbolic link and will not be modified: ${path}`);
    }
    if (!stat.isFile()) throw new Error(`instruction path is not a file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function withManagedBlock(existing: string | null, path: string): string {
  if (existing === null || existing.length === 0) return `${MANAGED_BLOCK}\n`;

  const starts = existing.split(INSTRUCTION_BLOCK_START).length - 1;
  const ends = existing.split(INSTRUCTION_BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) return `${existing.trimEnd()}\n\n${MANAGED_BLOCK}\n`;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`instruction file has a malformed skillmux managed block: ${path}`);
  }

  const start = existing.indexOf(INSTRUCTION_BLOCK_START);
  const end = existing.indexOf(INSTRUCTION_BLOCK_END, start);
  if (end < start) throw new Error(`instruction file has a malformed skillmux managed block: ${path}`);
  return `${existing.slice(0, start)}${MANAGED_BLOCK}${existing.slice(end + INSTRUCTION_BLOCK_END.length)}`;
}

export function planInstructionSetup(
  requestedClients: readonly ClientId[],
  options: InstructionPlanOptions = {},
): InstructionPlan {
  const home = options.home ?? process.env.HOME ?? "";
  const resolvedOptions = {
    home,
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"),
    claudeConfigDir: options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
  };
  const readFile = options.readFile ?? readInstructionFile;
  const changesByPath = new Map<string, InstructionChange>();
  const manual: InstructionPlan["manual"] = [];

  for (const client of [...new Set(requestedClients)]) {
    const path = instructionPath(client, resolvedOptions);
    if (!path) {
      manual.push({ client, reason: "no safe durable user instruction file is known" });
      continue;
    }
    const existingChange = changesByPath.get(path);
    if (existingChange) {
      existingChange.clients.push(client);
      continue;
    }

    const before = readFile(path);
    const after = withManagedBlock(before, path);
    changesByPath.set(path, {
      path,
      clients: [client],
      status: before === null ? "create" : before === after ? "unchanged" : "update",
      before,
      after,
    });
  }

  return { changes: [...changesByPath.values()], manual };
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function applyInstructionPlan(plan: InstructionPlan): void {
  for (const change of plan.changes) {
    if (change.status === "unchanged") continue;
    if (readInstructionFile(change.path) !== change.before) {
      throw new Error(`instruction file changed after planning: ${change.path}`);
    }
  }

  const applied: InstructionChange[] = [];
  try {
    for (const change of plan.changes) {
      if (change.status === "unchanged") continue;
      const mode = change.before === null ? 0o600 : statSync(change.path).mode;
      atomicWrite(change.path, change.after, mode);
      applied.push(change);
    }
  } catch (error) {
    rollbackInstructionChanges(applied);
    throw error;
  }
}

function rollbackInstructionChanges(changes: InstructionChange[]): void {
  for (const change of [...changes].reverse()) {
    if (change.before === null) {
      rmSync(change.path, { force: true });
    } else {
      atomicWrite(change.path, change.before, statSync(change.path).mode);
    }
  }
}

export function rollbackInstructionPlan(plan: InstructionPlan): void {
  rollbackInstructionChanges(plan.changes.filter((change) => change.status !== "unchanged"));
}
