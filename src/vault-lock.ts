/**
 * A small async read/write lock. Queries hold the read side while they read
 * the index and the vault, and a vault push holds the write side while it
 * swaps the files and reindexes. No query can then see half of an old vault
 * and half of a new one.
 *
 * A waiting writer blocks new readers, so a steady stream of queries cannot
 * starve a push. The callbacks must not take the lock again themselves: a
 * reader that asks for the read side while a writer is waiting would queue
 * behind that writer and deadlock.
 */
export class RwLock {
  private activeReaders = 0;
  private writing = false;
  private waitingReaders: Array<() => void> = [];
  private waitingWriters: Array<() => void> = [];

  async read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writing || this.waitingWriters.length > 0) {
      await new Promise<void>((resolve) => this.waitingReaders.push(resolve));
    } else {
      this.activeReaders++;
    }
    try {
      return await fn();
    } finally {
      this.activeReaders--;
      this.pump(false);
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writing || this.activeReaders > 0 || this.waitingWriters.length > 0) {
      await new Promise<void>((resolve) => this.waitingWriters.push(resolve));
    } else {
      this.writing = true;
    }
    try {
      return await fn();
    } finally {
      this.writing = false;
      this.pump(true);
    }
  }

  /**
   * Hands the lock on. Readers that queued while a writer ran go first, so
   * queries are held off only for the length of a push. When the last reader
   * leaves, a waiting writer goes next, which is what keeps readers that
   * arrived after that writer from overtaking it.
   */
  private pump(afterWrite: boolean): void {
    if (this.writing) return;
    if (afterWrite && this.waitingReaders.length > 0) {
      this.admitReaders();
      return;
    }
    if (this.activeReaders > 0) return;
    if (this.waitingWriters.length > 0) {
      this.writing = true;
      this.waitingWriters.shift()!();
    } else if (this.waitingReaders.length > 0) {
      this.admitReaders();
    }
  }

  private admitReaders(): void {
    const readers = this.waitingReaders.splice(0);
    this.activeReaders += readers.length;
    for (const release of readers) release();
  }
}

/**
 * The one lock every query and every vault replacement shares. Reads wrap
 * resolve_skill and fetch_skill; the vault push endpoint takes the write side.
 */
export const vaultLock = new RwLock();
