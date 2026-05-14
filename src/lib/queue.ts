// Simple in-process queue using Map and Set — no Redis needed.
// Lives for the duration of one agent run.

export class RuntimeQueue<T extends { id: string }> {
  private pending: Map<string, T> = new Map();
  private inProgress: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private failed: Set<string> = new Set();
  private seenHashes: Set<string> = new Set();   // dedup content hashes

  enqueue(items: T[]) {
    for (const item of items) {
      if (!this.completed.has(item.id) && !this.failed.has(item.id)) {
        this.pending.set(item.id, item);
      }
    }
  }

  dequeue(batchSize = 5): T[] {
    const batch: T[] = [];
    for (const [id, item] of this.pending) {
      if (batch.length >= batchSize) break;
      this.pending.delete(id);
      this.inProgress.add(id);
      batch.push(item);
    }
    return batch;
  }

  markDone(id: string) {
    this.inProgress.delete(id);
    this.completed.add(id);
  }

  markFailed(id: string) {
    this.inProgress.delete(id);
    this.failed.add(id);
  }

  isDuplicate(hash: string): boolean {
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    return false;
  }

  get stats() {
    return {
      pending: this.pending.size,
      inProgress: this.inProgress.size,
      completed: this.completed.size,
      failed: this.failed.size,
    };
  }

  hasWork(): boolean {
    return this.pending.size > 0 || this.inProgress.size > 0;
  }
}