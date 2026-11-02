import { isLoopbackBindHost } from "./config";

/** A shared HTTP MCP server an agent should connect to instead of spawning `skillmux serve`. */
export interface McpRemote {
  url: string;
  /** Name of the environment variable that holds the bearer token. The token itself is never stored. */
  tokenEnv?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates the endpoint and token variable a user typed. The token is only
 * ever referenced by name, because the registration lands in another tool's
 * config file and on a command line that other users on the machine can read.
 * A value pasted where a name belongs is refused for the same reason.
 */
export function parseMcpRemote(input: { url: string; tokenEnv?: string }): McpRemote {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error(`--mcp-url "${input.url}" is not a URL; expected something like https://skills.example.com/mcp`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`--mcp-url must be an http or https URL, not ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("--mcp-url must not contain credentials; pass the token through --mcp-token-env");
  }
  if (parsed.search) throw new Error("--mcp-url must not contain a query string");
  if (parsed.hash) throw new Error("--mcp-url must not contain a fragment");

  const tokenEnv = input.tokenEnv;
  if (tokenEnv !== undefined && !ENV_NAME.test(tokenEnv)) {
    throw new Error(
      "--mcp-token-env takes an environment variable name such as SKILLMUX_TOKEN, not the token itself",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol === "http:" && tokenEnv && !isLoopbackBindHost(hostname)) {
    throw new Error("refusing to send a bearer token over plain http to a non-loopback host; use https");
  }
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/mcp";
  return { url: parsed.toString(), ...(tokenEnv ? { tokenEnv } : {}) };
}

/** Takes the endpoint and token variable from a context in contexts.toml. */
export function mcpRemoteFromContext(context: { server: string; token_env?: string }): McpRemote {
  if (context.server === "local") {
    throw new Error("the local context has no remote server to register; pick a remote context");
  }
  return parseMcpRemote({ url: context.server, tokenEnv: context.token_env });
}

/** The agent expands `${NAME}` when it connects, so the secret stays out of its config file. */
export function remoteAuthorizationHeader(tokenEnv: string): string {
  return `Bearer \${${tokenEnv}}`;
}
