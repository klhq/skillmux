// Import-free on purpose: config.ts validates `agents` against this list, and
// the Dockerfile's model stage copies config.ts's closed import set. Keeping the
// ids apart from the agent registry keeps registry edits from busting that layer.
export const SUPPORTED_AGENT_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "github-copilot",
  "windsurf",
  "antigravity",
  "goose",
  "hermes",
] as const;

export type AgentId = (typeof SUPPORTED_AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (SUPPORTED_AGENT_IDS as readonly string[]).includes(value);
}
