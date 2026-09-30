import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertHostAllowed } from "./install";

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

/** Git must never stop to ask a question: sync runs unattended from chezmoi and hooks. */
function gitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
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

export async function updateVault(params: VaultUpdateParams): Promise<VaultUpdateResult> {
  const { vaultPath, vaultUrl, allowedHosts } = params;
  assertHostAllowed(vaultUrl, allowedHosts);
  if (existsSync(join(vaultPath, ".git"))) {
    const origin = await runGit(["remote", "get-url", "origin"], vaultPath);
    if (!origin.ok || origin.stdout !== vaultUrl) {
      throw new Error(
        `${vaultPath} has origin ${origin.ok ? origin.stdout : "(none)"}, but vault_url is ${vaultUrl}; refusing to update it`,
      );
    }
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
