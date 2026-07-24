import { watch } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import type { Config } from "./types";

// ---------------------------------------------------------------------------
// Live-reload allowlist (AC9)
// These are the ONLY top-level config keys that can be hot-reloaded.
// Any change outside this set results in restart_required_keys being populated
// but the current snapshot is NOT replaced (LKG stays active).
// ---------------------------------------------------------------------------

export const LIVE_RELOAD_KEYS = new Set([
  "inference.thresholds.match_score",
  "inference.thresholds.match_margin",
  "inference.thresholds.candidate_floor",
  "inference.calibration.run_id",
  "recall.k_lexical",
  "recall.k_vector",
  "thresholds.candidate_limit",
]);

// ---------------------------------------------------------------------------
// Status type (AC10)
// ---------------------------------------------------------------------------

export interface ReloadStatus {
  /** ISO timestamp of the last successful reload, or null if never reloaded. */
  last_successful_reload_at: string | null;
  /** Error message from the last failed reload, or null if last reload succeeded. */
  last_reload_error: string | null;
  /**
   * Keys that changed outside the live-reload allowlist.
   * Non-empty means a restart is needed to activate those changes.
   */
  restart_required_keys: string[];
}

// ---------------------------------------------------------------------------
// ConfigWatcher (AC8, AC9, AC10)
// ---------------------------------------------------------------------------

export interface ConfigWatcherOptions {
  /** Called on every successful, complete reload. */
  onReload: (config: Config) => void;
  /**
   * Called when the file cannot be read, parsed, or validated.
   * The previous good snapshot remains active — watcher does NOT crash.
   */
  onError: (error: unknown) => void;
}

const DEBOUNCE_MS = 300;
const STABLE_STAT_INTERVAL_MS = 80;
const STABLE_STAT_MAX_TRIES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changedConfigKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  prefix = "",
): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const previousValue = previous[key];
    const nextValue = next[key];
    if (!(key in previous) || !(key in next)) {
      if (isRecord(previousValue) || isRecord(nextValue)) {
        changed.push(
          ...changedConfigKeys(
            isRecord(previousValue) ? previousValue : {},
            isRecord(nextValue) ? nextValue : {},
            path,
          ),
        );
      } else {
        changed.push(path);
      }
      continue;
    }

    if (isRecord(previousValue) && isRecord(nextValue)) {
      changed.push(...changedConfigKeys(previousValue, nextValue, path));
    } else if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
      changed.push(path);
    }
  }

  return changed;
}

/**
 * Watch the parent directory of a TOML config file for changes.
 * Parent-dir watching catches both direct writes (change events) and
 * atomic renames (rename events) — both are needed for AC8.
 *
 * Reloading is transactional:
 *   1. Debounce burst events
 *   2. Wait for file size/mtime to stabilise (stable candidate read)
 *   3. Parse + validate the full config
 *   4. Call onReload only on success; on failure call onError (LKG stays)
 *
 * Only keys on LIVE_RELOAD_KEYS may trigger onReload without restart_required.
 */
export class ConfigWatcher {
  private status: ReloadStatus = {
    last_successful_reload_at: null,
    last_reload_error: null,
    restart_required_keys: [],
  };
  private stopped = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof watch>;

  private constructor(
    private readonly tomlPath: string,
    private readonly opts: ConfigWatcherOptions,
    private activeConfig: Config,
  ) {
    const dir = dirname(tomlPath);
    const filename = tomlPath.split(/[/\\]/).pop()!;

    this.watcher = watch(dir, { recursive: false }, (_event, changedName) => {
      if (this.stopped) return;
      // Fire for: the config file itself, or any .tmp variant of it (handles
      // pid-numbered atomics: config.toml.12345.tmp → rename → config.toml).
      // null/undefined changedName means directory-level change — treat as a hit.
      if (
        changedName &&
        changedName !== filename &&
        !changedName.startsWith(filename)
      ) {
        return;
      }
      this.scheduleReload();
    });

    this.watcher.on("error", (err) => {
      if (!this.stopped) {
        this.status = { ...this.status, last_reload_error: String(err) };
        this.opts.onError(err);
      }
    });
  }

  static async start(
    tomlPath: string,
    opts: ConfigWatcherOptions,
  ): Promise<ConfigWatcher> {
    const activeConfig = await loadConfig(tomlPath);
    return new ConfigWatcher(tomlPath, opts, activeConfig);
  }

  private scheduleReload(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.doReload();
    }, DEBOUNCE_MS);
  }

  private async doReload(): Promise<void> {
    if (this.stopped) return;

    // Wait for stable file (size + mtime stop changing)
    await this.waitForStable();
    if (this.stopped) return;

    try {
      const config = await loadConfig(this.tomlPath);
      const restartRequiredKeys = changedConfigKeys(
        this.activeConfig as unknown as Record<string, unknown>,
        config as unknown as Record<string, unknown>,
      )
        .filter((key) => !LIVE_RELOAD_KEYS.has(key))
        .sort();

      if (restartRequiredKeys.length > 0) {
        this.status = {
          ...this.status,
          last_reload_error: null,
          restart_required_keys: restartRequiredKeys,
        };
        return;
      }

      this.activeConfig = config;
      this.status = {
        last_successful_reload_at: new Date().toISOString(),
        last_reload_error: null,
        restart_required_keys: [],
      };
      this.opts.onReload(config);
    } catch (err) {
      this.status = {
        ...this.status,
        last_reload_error: err instanceof Error ? err.message : String(err),
      };
      this.opts.onError(err);
    }
  }

  private async waitForStable(): Promise<void> {
    let previous = "";
    for (let i = 0; i < STABLE_STAT_MAX_TRIES; i++) {
      const file = Bun.file(this.tomlPath);
      if (!(await file.exists())) return;
      const current = `${file.size}:${file.lastModified}`;
      if (current === previous) return;
      previous = current;
      await Bun.sleep(STABLE_STAT_INTERVAL_MS);
    }
  }

  /** Get a snapshot of the current watcher status. */
  reloadStatus(): ReloadStatus {
    return { ...this.status };
  }

  /** Stop the watcher and cancel any pending debounce. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    try {
      this.watcher.close();
    } catch {
      // already closed
    }
  }
}
