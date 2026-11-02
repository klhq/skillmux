import { updateVault, type VaultUpdateParams, type VaultUpdateResult, type VaultUpdateStatus } from "./vault-update";

export type PullResult = VaultUpdateResult | { status: "skipped" };

export interface VaultPullerOptions {
  vaultPath: string;
  vaultUrl: string;
  /** `[egress] allowed_hosts`; vaultUrl's host must be listed when set. */
  allowedHosts?: string[];
  intervalMs: number;
  /** Stops live reindexing and returns the function that restarts it. */
  pauseWatcher: () => () => void;
  /** Takes the finished tree into the index in one step. Runs only after the tree changed. */
  resync: () => Promise<void>;
  onResult?: (status: VaultUpdateStatus) => void;
  warn?: (message: string) => void;
  /** Replaceable in tests. */
  update?: (params: VaultUpdateParams) => Promise<VaultUpdateResult>;
}

export interface VaultPuller {
  /** Runs one pull now. Resolves to "skipped" without doing anything when a pull is already running. */
  pullNow(): Promise<PullResult>;
  stop(): void;
}

/**
 * Keeps a served vault current from its git remote. A pull that cannot finish
 * never stops the server: the checkout is left as it was, a warning is logged,
 * and the next tick tries again.
 */
export function startVaultPuller(options: VaultPullerOptions): VaultPuller {
  const { vaultPath, vaultUrl, allowedHosts, pauseWatcher, resync, onResult } = options;
  const warn = options.warn ?? (() => {});
  const update = options.update ?? updateVault;
  let running = false;

  async function pullNow(): Promise<PullResult> {
    if (running) return { status: "skipped" };
    running = true;
    const resume = pauseWatcher();
    try {
      let result: VaultUpdateResult;
      try {
        result = await update({ vaultPath, vaultUrl, allowedHosts });
      } catch (error) {
        result = { status: "failed", warning: error instanceof Error ? error.message : String(error) };
      }
      if (result.warning) warn(`vault pull: ${result.warning}`);
      if (result.status === "cloned" || result.status === "updated") {
        try {
          await resync();
        } catch (error) {
          warn(`vault pull: reindex after ${result.status} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    } finally {
      resume();
      running = false;
    }
  }

  async function tracked(): Promise<PullResult> {
    const result = await pullNow();
    if (result.status !== "skipped") onResult?.(result.status);
    return result;
  }

  const timer = setInterval(() => void tracked(), options.intervalMs);
  timer.unref();

  return { pullNow: tracked, stop: () => clearInterval(timer) };
}
