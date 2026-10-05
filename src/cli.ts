#!/usr/bin/env bun
import packageJson from "../package.json" with { type: "json" };
import { setConfigNoticeHandler } from "./config";
import { getEffectiveConfig } from "./config-service";
import { buildRedactor } from "./redact";
import {
  DEFAULT_CONTEXTS_PATH,
  contextSource,
  resolveContext,
  type ContextSource,
  type ResolvedContext,
} from "./context";
import { createContextAdapter } from "./adapters";
import {
  CliError,
  formatJsonEnvelope,
  mapExitCode,
  note,
  dim,
  renderError,
  routeStderrUncolored,
  setColorDisabled,
  styleHelp,
  suggestCorrection,
  warn,
} from "./output";
import { COMMAND_HELP } from "./command-help";
import { REMOVED_COMMANDS, findHandler } from "./command-handlers";
import {
  COMMANDS,
  KNOWN_COMMANDS,
  findCommand,
  isDockerHostOnly,
  type CommandContextSupport,
  type LocalOnlyReason,
} from "./command-registry";
import { SUPPORTED_AGENT_IDS } from "./init-agents";

export { KNOWN_COMMANDS };

/**
 * Declared context support for every command in the registry: the single
 * source of truth getLocalOnlyCommand() enforces against. See
 * CommandContextSupport in command-registry.ts for the three classifications,
 * and tests/cli-context-support.test.ts, which fails the build if a command
 * drifts out of sync.
 *
 * Subcommand-level exceptions within an otherwise-classified command (e.g.
 * `config init`, which bootstraps *this machine's* config file and so is
 * local-only despite `config` overall being remote-capable) come from
 * `localOnlySubcommands` in the registry.
 */
export type { CommandContextSupport };

export const COMMAND_CONTEXT_SUPPORT: Record<string, CommandContextSupport> =
  Object.fromEntries(COMMANDS.map((c) => [c.name, c.contextSupport]));

export function getLocalOnlyCommand(command: string, subCommand: string): string | null {
  const spec = findCommand(command);
  if (!spec) return null;
  if (spec.contextSupport === "local-only") {
    // `skill` takes only `which`, so a bare `skill` is rejected under that name too.
    return spec.localOnlyLabel ?? command;
  }
  if (subCommand && spec.localOnlySubcommands?.[subCommand]) {
    return `${command} ${subCommand}`;
  }
  return null;
}

/**
 * Why a local-only command can't take a remote context, keyed by the exact
 * string getLocalOnlyCommand() returns. Drives the guidance sentence
 * remoteContextUnsupported() appends, so the rejection points somewhere
 * useful instead of just saying no.
 */
const LOCAL_ONLY_REASON: Record<string, LocalOnlyReason> = Object.fromEntries(
  COMMANDS.flatMap((c): [string, LocalOnlyReason][] => [
    ...(c.localOnlyReason ? [[c.localOnlyLabel ?? c.name, c.localOnlyReason] as [string, LocalOnlyReason]] : []),
    ...Object.entries(c.localOnlySubcommands ?? {}).map(
      ([sub, reason]) => [`${c.name} ${sub}`, reason] as [string, LocalOnlyReason],
    ),
  ]),
);

const LOCAL_ONLY_GUIDANCE: Record<LocalOnlyReason, string> = {
  "vault-content":
    "To change a remote deployment's vault contents, update its git-backed source and redeploy or pull on that host — skillmux doesn't replicate vault checkouts over the network.",
  "native-delivery":
    "This manages skill delivery into agent directories on the machine you run it from; there's no remote equivalent — run it on the machine that owns those directories.",
  "local-runtime":
    "This operates on the local runtime process on the machine you run it from.",
  "local-config":
    "This bootstraps this machine's own config file. To inspect or change a remote deployment's configuration, use \"skillmux config show/set --context <name>\" instead.",
};

function describeTarget(target: Extract<ResolvedContext, { type: "remote" }>): string {
  return target.name === "custom" ? target.server : `"${target.name}" (${target.server})`;
}

/** How to run the command on this machine instead, given what selected the remote target. */
function localEscapeHint(source: ContextSource): string {
  switch (source.kind) {
    case "flag":
      return `To run it on this machine, drop ${source.flag} or pass --context local.`;
    case "env":
      return `To run it on this machine, unset ${source.variable} or pass --context local.`;
    case "default":
      return 'To run it on this machine, pass --context local, or switch the default with "skillmux context use local".';
  }
}

function describeSource(source: ContextSource): string {
  switch (source.kind) {
    case "flag":
      return `the ${source.flag} flag`;
    case "env":
      return `the ${source.variable} environment variable`;
    case "default":
      return `the default context in ${DEFAULT_CONTEXTS_PATH}`;
  }
}

function remoteContextUnsupported(
  rejectedCommand: string,
  target: Extract<ResolvedContext, { type: "remote" }>,
  source: ContextSource,
): CliError {
  const reason = LOCAL_ONLY_REASON[rejectedCommand];
  const lines = [
    `\`${rejectedCommand}\` operates on the local vault only; --context/--server isn't supported here.`,
    `The target ${describeTarget(target)} came from ${describeSource(source)}.`,
    localEscapeHint(source),
    ...(reason ? [LOCAL_ONLY_GUIDANCE[reason]] : []),
  ];
  return new CliError(lines.join("\n"), 2, "REMOTE_CONTEXT_UNSUPPORTED", {
    rejected_command: rejectedCommand,
    ...(reason ? { reason } : {}),
    target: { name: target.name, server: target.server },
    source,
  });
}

function containerCommandUnsupported(command: string, subCommand: string): CliError {
  const rejectedCommand = [command, subCommand].filter(Boolean).join(" ");
  const recommendedHostCommand = `skillmux ${rejectedCommand}`;
  const guide = "docs/deployment.md";
  const documentation =
    "https://github.com/klhq/skillmux/blob/main/docs/deployment.md#container-command-contract";
  return new CliError(
    `\`skillmux ${rejectedCommand}\` manages host agent directories and cannot run in the Skillmux server image.\n\n` +
      "Install the host CLI:\n" +
      "  bun add -g @klhapp/skillmux\n\n" +
      "Then run:\n" +
      `  ${recommendedHostCommand}\n\n` +
      `See ${guide} for server deployment examples.`,
    2,
    "CONTAINER_COMMAND_UNSUPPORTED",
    {
      // `command` remains for automation written against the first Docker
      // boundary release. `rejected_command` is the explicit contract name.
      command: rejectedCommand,
      rejected_command: rejectedCommand,
      recommended_host_command: recommendedHostCommand,
      guide,
      documentation,
    },
  );
}

async function main() {
  // --no-color is purely global: strip it before dispatch so no command's own
  // option parser has to know about it (they reject options they don't know).
  const rawArgv = Bun.argv.slice(2).filter((arg) => arg !== "--no-color");
  routeStderrUncolored();
  setConfigNoticeHandler((kind, line) => (kind === "warning" ? warn(line) : note(line)));
  if (rawArgv.length !== Bun.argv.length - 2) setColorDisabled(true);

  let isJson = process.env.SKILLMUX_JSON === "true";
  let allowInsecure = false;
  let isVerbose = false;
  let flagContext: string | undefined;
  let flagServer: string | undefined;
  let isDryRun = false;
  // Global flags do not form part of the command identity reported to users.
  // In particular, `init --json` should recommend `skillmux init`, not a
  // redundant JSON-only host command.
  const subCommand = rawArgv[1]?.startsWith("-") ? "" : rawArgv[1] ?? "";
  const commandArgs = rawArgv.slice(2);

  const command = rawArgv[0];
  if (command === "--version" || command === "-V") {
    console.log(packageJson.version);
    return;
  }

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  // Parse global flags for context/config
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (arg === "--json") isJson = true;
    else if (arg === "--allow-insecure") allowInsecure = true;
    else if (arg === "--verbose") isVerbose = true;
    else if (arg === "--dry-run") isDryRun = true;
    else if (arg === "--context") flagContext = rawArgv[++i];
    else if (arg === "--server") flagServer = rawArgv[++i];
  }

  let resolvedContext: ResolvedContext = { type: "local", name: "local" };

  if (
    process.env.RUNNING_IN_DOCKER === "true" &&
    isDockerHostOnly(command, subCommand)
  ) {
    await handleError(containerCommandUnsupported(command, subCommand), {
      context: resolvedContext,
      isJson,
      isVerbose,
    });
    return;
  }

  if (
    (rawArgv.includes("--help") || rawArgv.includes("-h")) &&
    printCommandHelp(command)
  ) {
    return;
  }

  try {
    resolvedContext = await resolveContext({
      context: flagContext,
      server: flagServer,
    });
  } catch (err: any) {
    await handleError(err, { context: resolvedContext, isJson, isVerbose });
    return;
  }

  const localOnlyCommand = getLocalOnlyCommand(command, subCommand);
  if (localOnlyCommand && resolvedContext.type === "remote") {
    await handleError(
      remoteContextUnsupported(
        localOnlyCommand,
        resolvedContext,
        contextSource({ context: flagContext, server: flagServer }),
      ),
      { context: resolvedContext, isJson, isVerbose },
    );
    return;
  }

  const adapter = createContextAdapter(resolvedContext, { allowInsecure });

  try {
    const handler = findHandler(command);
    if (!handler) {
      if (Object.hasOwn(REMOVED_COMMANDS, command)) throw new Error(REMOVED_COMMANDS[command]!(subCommand));
      const suggestion = suggestCorrection(command, KNOWN_COMMANDS);
      throw new Error(
        suggestion
          ? `Unknown command "${command}". Did you mean "${suggestion}"?`
          : `Unknown command "${command}". Run "skillmux --help" to see the available commands: ${KNOWN_COMMANDS.join(", ")}.`,
      );
    }
    await handler({
      args: rawArgv.slice(1),
      subCommand,
      subArgs: commandArgs,
      isJson,
      isDryRun,
      isVerbose,
      allowInsecure,
      context: resolvedContext,
      adapter,
    });
  } catch (err: any) {
    await handleError(err, { context: resolvedContext, isJson, isVerbose });
  }
}



async function handleError(
  err: any,
  opts: { context: ResolvedContext; isJson: boolean; isVerbose: boolean },
) {
  const code = mapExitCode(err);
  process.exitCode = code;

  const rawMsg = err instanceof Error ? err.message : String(err);
  // Best-effort: a broken config must not suppress the original error report,
  // so fall back to the URL-credential-only layer of buildRedactor(undefined)
  // rather than let a config-load failure mask the real failure.
  let redact: (text: string) => string;
  try {
    const { effective } = await getEffectiveConfig();
    redact = buildRedactor(effective);
  } catch {
    redact = buildRedactor(undefined);
  }
  const msg = redact(rawMsg);

  if (opts.isJson) {
    const env = formatJsonEnvelope({
      ok: false,
      context: opts.context,
      error: {
        code: err instanceof CliError ? err.code : `EXIT_${code}`,
        message: msg,
        details: err instanceof CliError ? err.details : undefined,
      },
    });
    console.log(JSON.stringify(env));
  } else {
    console.error(renderError(msg));
    if (opts.isVerbose && err instanceof Error && err.stack) {
      console.error(dim(redact(err.stack), "stderr"));
    }
  }
}

function printCommandHelp(command: string): boolean {
  const help = COMMAND_HELP[command];
  if (!help) return false;
  console.log(styleHelp(help));
  return true;
}

function printHelp(): void {
  if (process.env.RUNNING_IN_DOCKER === "true") {
    console.log(`Skillmux server image

Default:
  serve --transport http

Supported commands:
  serve, index, doctor, report, audit prune, eval promote, scan, skill which
  config show|get|validate|diff|status

Native skill management:
  Install the Skillmux CLI on the host for init, install, pinning, and sync.

See docs/deployment.md for server deployment examples.`);
    return;
  }

  console.log(styleHelp(`usage: skillmux <command> [options]

Setup:
  skillmux init [--agent <name>...] [--vault <path>] [--core <skill_id>...]
                [--migrate-full-vault] [--show-mcp-setup] [--register-mcp]
                [--no-instructions] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project init [path] [--name <group>] [--skill <skill_id>...]
                [--agent <name>...] [--no-sync]
                [--interactive|--yes|--dry-run] [--json]
  skillmux project <list|show|add-path|remove-path|pin|unpin|attach|detach>
  skillmux agent <list|add|remove|rehome>  (which agents this machine syncs skills to)
  skillmux core <pin|unpin> <skill_id>... [--yes] [--dry-run] [--json]
  skillmux skill which <skill_id>  (local vault shadow resolution; unrelated to MCP routing)
  skillmux config init --vault <path> --yes
                (bootstraps this machine's config on its own; not a
                prerequisite, since "skillmux init --vault" does the same)

Init agents:
  ${SUPPORTED_AGENT_IDS.join(", ")}
  ("skillmux init --show-mcp-setup" also prints the MCP registration
  snippet, independent of which agents you select. A tool not in this
  list isn't supported by init yet — see "skillmux init --help".)

Operations:
  skillmux report [--context <name> | --server <url> | --db <path>] --since <window> [--json]
  skillmux audit prune [--older-than <window>] [--dry-run] [--yes] [--json]
  skillmux eval promote --since <window> [--out <path>] [--dry-run] [--yes] [--json]
  skillmux outdated [--allow-local-source] [--json]
  skillmux update [skill-id] [--yes] [--dry-run] [--force] [--allow-local-source] [--fail-on low|medium|high|none] [--json]

Commands:
  ${KNOWN_COMMANDS.join(", ")}

Global options: --json, --verbose, --dry-run, --no-color, --context <name>, --server <url>

Run "skillmux <command> --help" for a command's full usage.`));
}

if (import.meta.main) {
  await main();
}
