/**
 * The single source of truth for what top-level commands exist and how each
 * one behaves. cli.ts (dispatch guards, unknown-command usage, help),
 * completions.ts (command and subcommand lists), and the consistency tests all
 * derive from this table.
 *
 * To add a command:
 *   1. Add an entry to COMMAND_TABLE below.
 *   2. Add its help text to command-help.ts, documenting every flag it takes
 *      (completions and "did you mean" suggestions read the flags from there).
 *   3. Add its handler to HANDLERS in command-handlers.ts.
 * Steps 1 and 3 are linked by the type system: HANDLERS is a
 * Record<CommandName, CommandHandler>, so registering a command without a
 * handler, or the reverse, fails `tsc` instead of surfacing as "Unknown command".
 */

/**
 * - "local-only": operates on this machine's vault/filesystem/agents only;
 *   a remote context is rejected outright.
 * - "remote-capable": routed through ContextAdapter, backed by LocalAdapter or
 *   RemoteAdapter depending on the resolved context.
 * - "context-agnostic": the resolved context isn't used to decide behavior
 *   (context management is inherently local; completions never touch
 *   vault/server state).
 */
export type CommandContextSupport = "local-only" | "remote-capable" | "context-agnostic";

/** Why a local-only command can't take a remote context; selects the guidance sentence. */
export type LocalOnlyReason = "vault-content" | "native-delivery" | "local-runtime" | "local-config";

export interface CommandSpec {
  name: string;
  /** One line, shown in shell completions. */
  description: string;
  /** Valid first arguments, used for completions and "did you mean" errors. */
  subcommands?: readonly string[];
  contextSupport: CommandContextSupport;
  /** Required when contextSupport is "local-only". */
  localOnlyReason?: LocalOnlyReason;
  /**
   * Name reported in the remote-context rejection when it differs from `name`
   * (`skill` only ever means `skill which`).
   */
  localOnlyLabel?: string;
  /**
   * Subcommands of an otherwise remote-capable command that are local-only,
   * mapped to their reason (`config init` bootstraps this machine's config).
   */
  localOnlySubcommands?: Readonly<Record<string, LocalOnlyReason>>;
  /**
   * True when the Docker server image rejects the command, or a predicate on
   * the subcommand when only some forms are rejected.
   */
  dockerHostOnly?: boolean | ((subCommand: string) => boolean);
}

const COMMAND_TABLE = [
  {
    name: "context",
    description: "Manage connection contexts",
    subcommands: ["add", "list", "current", "use", "remove"],
    contextSupport: "context-agnostic",
    dockerHostOnly: true,
  },
  {
    name: "config",
    description: "Manage configuration",
    subcommands: ["init", "show", "get", "validate", "diff", "set", "status"],
    contextSupport: "remote-capable",
    localOnlySubcommands: { init: "local-config" },
    dockerHostOnly: (sub) => ["init", "set"].includes(sub),
  },
  {
    name: "completions",
    description: "Generate shell completions",
    subcommands: ["bash", "zsh", "fish"],
    contextSupport: "context-agnostic",
  },
  {
    name: "serve",
    description: "Start MCP server",
    contextSupport: "local-only",
    localOnlyReason: "local-runtime",
  },
  {
    name: "index",
    description: "Rebuild local search index",
    contextSupport: "local-only",
    localOnlyReason: "local-runtime",
  },
  {
    name: "sync",
    description: "Synchronize vault skills",
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
  {
    name: "init",
    description: "Configure this machine and its agents",
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
  {
    name: "project",
    description: "Configure project-scoped skills",
    subcommands: ["init", "list", "show", "add-path", "remove-path", "pin", "unpin", "attach", "detach"],
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
  {
    name: "agent",
    description: "Choose which agents this machine syncs to",
    subcommands: ["list", "add", "remove", "rehome"],
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
  {
    name: "core",
    description: "Pin/unpin skills into [core]",
    subcommands: ["pin", "unpin"],
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
  {
    name: "report",
    description: "Generate usage stats",
    contextSupport: "remote-capable",
  },
  {
    name: "audit",
    description: "Prune the audit database",
    subcommands: ["prune"],
    contextSupport: "remote-capable",
  },
  {
    name: "scan",
    description: "Audit skills for issues",
    contextSupport: "local-only",
    localOnlyReason: "vault-content",
  },
  {
    name: "install",
    description: "Install skills into vault",
    contextSupport: "local-only",
    localOnlyReason: "vault-content",
    dockerHostOnly: true,
  },
  {
    name: "outdated",
    description: "List skills with a newer upstream version",
    contextSupport: "local-only",
    localOnlyReason: "vault-content",
    dockerHostOnly: true,
  },
  {
    name: "update",
    description: "Update installed skills",
    contextSupport: "local-only",
    localOnlyReason: "vault-content",
    dockerHostOnly: true,
  },
  {
    name: "eval",
    description: "Evaluate search accuracy",
    subcommands: ["promote"],
    contextSupport: "remote-capable",
    // `eval promote` only touches the mounted state_dir; bare `eval` (vault
    // ranking evaluation) needs an embeddings client and the vault.
    dockerHostOnly: (sub) => sub !== "promote",
  },
  {
    name: "doctor",
    description: "Check runtime health",
    contextSupport: "remote-capable",
  },
  {
    name: "models",
    description: "Manage local models",
    subcommands: ["download"],
    contextSupport: "local-only",
    localOnlyReason: "local-runtime",
    dockerHostOnly: true,
  },
  {
    name: "skill",
    description: "Show which root resolves a skill_id",
    subcommands: ["which"],
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    localOnlyLabel: "skill which",
  },
  {
    name: "local-vault",
    description: "Manage local_vault_paths discoverability markers",
    subcommands: ["init"],
    contextSupport: "local-only",
    localOnlyReason: "native-delivery",
    dockerHostOnly: true,
  },
] as const satisfies readonly CommandSpec[];

/**
 * The name of every registered command, as a literal union derived from the
 * table above. command-handlers.ts types its dispatch table as
 * Record<CommandName, ...>, so a command added here without a handler (or a
 * handler for a command that is not registered) fails to compile.
 */
export type CommandName = (typeof COMMAND_TABLE)[number]["name"];

export const COMMANDS: readonly CommandSpec[] = COMMAND_TABLE;

export const KNOWN_COMMANDS: readonly string[] = COMMAND_TABLE.map((c) => c.name);

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function isDockerHostOnly(command: string, subCommand: string): boolean {
  const flag = findCommand(command)?.dockerHostOnly;
  return typeof flag === "function" ? flag(subCommand) : flag === true;
}
