import { resolve } from "node:path";
import { unknownOptionError } from "./arg-errors";
import { expandHome } from "./config";
import type { Config } from "./types";

export type ServeTransport = "stdio" | "http";

/** Paths and bind address an operator can pass instead of writing a config file. */
export interface ServeOverrides {
  vault?: string;
  stateDir?: string;
  host?: string;
}

export interface ServeArgs {
  transport: ServeTransport;
  port?: number;
  statsPort?: number;
  overrides: ServeOverrides;
}

function portValue(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function requiredValue(name: string, value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** A relative path would depend on where the process was started, so pin it. ~ is left for config to expand. */
function absolutePath(value: string): string {
  return value.startsWith("~") ? value : resolve(value);
}

export function parseServeArgs(args: string[]): ServeArgs {
  const parsed: ServeArgs = { transport: "stdio", overrides: {} };
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    const value = args[i + 1];
    if (option === "--transport") {
      if (value !== "stdio" && value !== "http") throw new Error("--transport must be stdio or http");
      parsed.transport = value;
    } else if (option === "--port") {
      parsed.port = portValue(option, value);
    } else if (option === "--stats-port") {
      parsed.statsPort = portValue(option, value);
    } else if (option === "--vault") {
      parsed.overrides.vault = absolutePath(requiredValue(option, value));
    } else if (option === "--state-dir") {
      parsed.overrides.stateDir = absolutePath(requiredValue(option, value));
    } else if (option === "--host") {
      parsed.overrides.host = requiredValue(option, value);
    } else {
      throw unknownOptionError("serve", option);
    }
    i++;
  }
  return parsed;
}

/**
 * The flags ride the environment variables loadConfig already honours, so they
 * also survive a config hot reload, which loads the file again.
 */
export function applyServeOverrides(
  overrides: ServeOverrides,
  env: Record<string, string | undefined> = process.env,
): void {
  if (overrides.vault) env.SKILLMUX_VAULT_PATH = overrides.vault;
  if (overrides.stateDir) env.SKILLMUX_STATE_DIR = overrides.stateDir;
  if (overrides.host) env.SKILLMUX_HTTP_HOSTNAME = overrides.host;
}

/**
 * A config file can turn environment overrides off, and then the flags would be
 * dropped without a word. The server would start on a different vault or
 * address than the operator asked for, so say so instead.
 */
export function verifyServeOverrides(overrides: ServeOverrides, config: Config): void {
  const ignored: string[] = [];
  if (overrides.vault && expandHome(config.vault_path) !== expandHome(overrides.vault)) ignored.push("--vault");
  if (overrides.stateDir && expandHome(config.state_dir) !== expandHome(overrides.stateDir)) ignored.push("--state-dir");
  if (overrides.host && config.server?.hostname !== overrides.host) ignored.push("--host");
  if (ignored.length > 0) {
    throw new Error(
      `${ignored.join(", ")} had no effect because the config sets environment_overrides = false; ` +
        "set the value in the config file instead, or remove that setting",
    );
  }
}
