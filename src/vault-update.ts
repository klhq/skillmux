import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "./config";
import { assertHostAllowed } from "./install";
import type { Config } from "./types";

export type VaultUpdateStatus = "cloned" | "updated" | "up-to-date" | "failed";

export interface VaultUpdateResult {
  status: VaultUpdateStatus;
  /** Set when the vault could not be brought current; sync carries on with whatever is on disk. */
  warning?: string;
}

export interface VaultUpdateParams {
  vaultPath: string;
  vaultUrl: string;
  /** `[egress] allowed_hosts`; when set, vaultUrl's host must be listed. */
  allowedHosts?: string[];
}

/**
 * Set on every git call made for a vault update. The post-merge hook that
 * `skillmux sync --install-hook` writes runs `skillmux sync`, and git hands it
 * this environment, so that nested sync can see it was started by a pull and
 * must not pull again.
 */
export const SYNC_ACTIVE_ENV = "SKILLMUX_SYNC_ACTIVE";

/** Git must never stop to ask a question: sync runs unattended from chezmoi and hooks. */
function gitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    [SYNC_ACTIVE_ENV]: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
    // Abort an http transfer that stays under 1000 B/s for 30 s, so a stalled remote cannot hang sync.
    GIT_HTTP_LOW_SPEED_LIMIT: process.env.GIT_HTTP_LOW_SPEED_LIMIT ?? "1000",
    GIT_HTTP_LOW_SPEED_TIME: process.env.GIT_HTTP_LOW_SPEED_TIME ?? "30",
  };
}

async function runGit(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv() });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Refuses a vault_url the config must not fetch, or a checkout that belongs to another remote. Touches no network. */
async function assertVaultTarget({ vaultPath, vaultUrl, allowedHosts }: VaultUpdateParams): Promise<void> {
  assertHostAllowed(vaultUrl, allowedHosts);
  if (!existsSync(join(vaultPath, ".git"))) return;
  const origin = await runGit(["remote", "get-url", "origin"], vaultPath);
  if (!origin.ok || origin.stdout !== vaultUrl) {
    throw new Error(
      `${vaultPath} has origin ${origin.ok ? origin.stdout : "(none)"}, but vault_url is ${vaultUrl}; refusing to update it`,
    );
  }
}

export async function updateVault(params: VaultUpdateParams): Promise<VaultUpdateResult> {
  const { vaultPath, vaultUrl } = params;
  await assertVaultTarget(params);
  if (existsSync(join(vaultPath, ".git"))) {
    const dirty = await runGit(["status", "--porcelain", "--untracked-files=no"], vaultPath);
    if (dirty.stdout !== "") {
      return { status: "failed", warning: `${vaultPath} has uncommitted changes; not updating it` };
    }
    const before = await runGit(["rev-parse", "HEAD"], vaultPath);
    const pull = await runGit(["pull", "--ff-only", "--quiet"], vaultPath);
    if (!pull.ok) return { status: "failed", warning: `git pull failed in ${vaultPath}: ${pull.stderr}` };
    const after = await runGit(["rev-parse", "HEAD"], vaultPath);
    return { status: before.stdout === after.stdout ? "up-to-date" : "updated" };
  }
  mkdirSync(dirname(vaultPath), { recursive: true });
  const clone = await runGit(["clone", "--quiet", "--", vaultUrl, vaultPath]);
  if (!clone.ok) return { status: "failed", warning: `git clone failed for ${vaultUrl}: ${clone.stderr}` };
  return { status: "cloned" };
}

export type VaultSkipReason = "no-vault-url" | "no-agents" | "no-pull" | "dry-run" | "nested";

export type RefreshVaultResult =
  | VaultUpdateResult
  | { status: "skipped"; reason: VaultSkipReason; would?: "clone" | "update" };

export interface RefreshVaultOptions {
  dryRun: boolean;
  noPull: boolean;
}

/**
 * Decides whether `skillmux sync` should bring the vault current, and does it.
 * A host without vault_url, or without agents to deliver skills to, is left
 * exactly as it was.
 */
export async function refreshVault(
  config: Pick<Config, "vault_path" | "vault_url" | "agents" | "egress">,
  options: RefreshVaultOptions,
): Promise<RefreshVaultResult> {
  if (config.vault_url === undefined) return { status: "skipped", reason: "no-vault-url" };
  if (config.agents.length === 0) return { status: "skipped", reason: "no-agents" };
  if (process.env[SYNC_ACTIVE_ENV] === "1") return { status: "skipped", reason: "nested" };
  if (options.noPull) return { status: "skipped", reason: "no-pull" };
  const vaultPath = expandHome(config.vault_path);
  const target = { vaultPath, vaultUrl: config.vault_url, allowedHosts: config.egress?.allowed_hosts };
  if (options.dryRun) {
    await assertVaultTarget(target);
    return { status: "skipped", reason: "dry-run", would: existsSync(join(vaultPath, ".git")) ? "update" : "clone" };
  }
  return updateVault(target);
}
