import type { Database } from "bun:sqlite";
import { expandHome } from "./config";
import { openIndex } from "./db";
import type { Clients, Config } from "./types";

// ---------------------------------------------------------------------------
// Immutable runtime snapshot (AC11)
// ---------------------------------------------------------------------------

/**
 * An immutable, reference-counted view of runtime resources.
 * All fields are frozen at construction — callers can never mutate the snapshot.
 * The underlying db handle is closed only after every holder calls release().
 */
export interface RuntimeSnapshot {
  readonly config: Config;
  readonly clients: Clients;
  readonly db: Database;
}

/**
 * A handle returned by RuntimeSnapshotManager.acquire().
 * Call release() exactly once when the request (or operation) is done.
 */
export interface SnapshotHandle {
  readonly snapshot: RuntimeSnapshot;
  release(): void;
}

// ---------------------------------------------------------------------------
// Internal reference-counted slot
// ---------------------------------------------------------------------------

class SnapshotSlot {
  private refCount = 0;
  private closed = false;
  readonly snapshot: RuntimeSnapshot;

  constructor(config: Config, clients: Clients) {
    const stateDir = expandHome(config.state_dir);
    const db = openIndex(stateDir);
    // Freeze the snapshot object so callers cannot mutate it
    this.snapshot = Object.freeze({ config, clients, db });
  }

  acquire(): SnapshotHandle {
    this.refCount++;
    let released = false;
    return {
      snapshot: this.snapshot,
      release: () => {
        if (released) return; // idempotent
        released = true;
        this.refCount--;
        this.maybeClose();
      },
    };
  }

  /** Signal that no new acquires will come from the manager for this slot. */
  retire(): void {
    this.closed = true;
    this.maybeClose();
  }

  private maybeClose(): void {
    if (this.closed && this.refCount === 0) {
      try {
        this.snapshot.db.close();
      } catch {
        // already closed — idempotent
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public manager
// ---------------------------------------------------------------------------

/**
 * RuntimeSnapshotManager holds one active SnapshotSlot at a time.
 *
 * - acquire() → returns a SnapshotHandle for the current slot; increments its refcount.
 * - replace() → installs a new slot; retires the previous one (closed when all
 *   in-flight holders release, i.e. no handle leak).
 * - dispose() → retires the current slot and blocks future acquires.
 */
export class RuntimeSnapshotManager {
  private current: SnapshotSlot;
  private disposed = false;

  private constructor(config: Config, clients: Clients) {
    this.current = new SnapshotSlot(config, clients);
  }

  static create(config: Config, clients: Clients): RuntimeSnapshotManager {
    return new RuntimeSnapshotManager(config, clients);
  }

  /**
   * Acquire a handle to the current snapshot.
   * The caller MUST call release() when done — even on error paths.
   */
  acquire(): SnapshotHandle {
    if (this.disposed) {
      throw new Error("RuntimeSnapshotManager has been disposed");
    }
    return this.current.acquire();
  }

  /**
   * Swap in a new configuration and clients.
   * The previous slot is retired and will close its db handle once all
   * in-flight holders release.
   */
  replace(config: Config, clients: Clients): void {
    if (this.disposed) {
      throw new Error("RuntimeSnapshotManager has been disposed");
    }
    const outgoing = this.current;
    this.current = new SnapshotSlot(config, clients);
    outgoing.retire(); // closes when refCount reaches zero
  }

  /**
   * Permanently shut down. Retires the current slot.
   * Any future acquire() will throw.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current.retire();
  }
}
