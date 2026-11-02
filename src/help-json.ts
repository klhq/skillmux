import packageJson from "../package.json" with { type: "json" };
import { GLOBAL_FLAGS } from "./arg-errors";
import { COMMAND_HELP, documentedFlags } from "./command-help";
import { COMMANDS, type CommandSpec } from "./command-registry";

export interface CommandDescription {
  name: string;
  description: string;
  subcommands: readonly string[];
  /** True when every form writes, false when none does. */
  writes: boolean;
  /** Subcommands that write while the rest of the command only reads; empty when `writes` says it all. */
  writing_subcommands: readonly string[];
  context_support: CommandSpec["contextSupport"];
  /** Flags the command documents in its own help, excluding the global ones. */
  flags: string[];
  /** The command's full help text. */
  help: string;
}

export interface HelpDescription {
  version: string;
  global_flags: readonly string[];
  commands: CommandDescription[];
}

/**
 * The command registry as data, for `--help --json`. Everything derives from
 * the registry and the help text, so it cannot drift from what the CLI accepts.
 */
export function describeCommands(only?: string): HelpDescription {
  const globals = new Set<string>(GLOBAL_FLAGS);
  return {
    version: packageJson.version,
    global_flags: [...GLOBAL_FLAGS, "--help"],
    commands: COMMANDS.filter((spec) => only === undefined || spec.name === only).map((spec) => ({
      name: spec.name,
      description: spec.description,
      subcommands: spec.subcommands ?? [],
      writes: spec.writes === true,
      writing_subcommands: Array.isArray(spec.writes) ? spec.writes : [],
      context_support: spec.contextSupport,
      flags: documentedFlags(spec.name).filter((flag) => !globals.has(flag)),
      help: COMMAND_HELP[spec.name] ?? "",
    })),
  };
}
