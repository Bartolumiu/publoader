/**
 * Serialises the parts of the upload flow that hold a MangaDex upload session.
 *
 * MangaDex allows ONE open upload session per account. That is an account-wide
 * limit, not a per-queue one, so it survives the queues being drained
 * concurrently only if the session-holding stretch of each worker is the thing
 * that takes turns. Everything either side of it -- reading the chapter,
 * rendering the card, archiving the row, waiting on a confirmation -- touches
 * no session and runs in parallel, which is the whole point of splitting the
 * queues: a card no longer waits behind a chapter's page set, it only waits to
 * put its own image up.
 *
 * Without this the split is actively worse than one loop. Two drains that each
 * open a session tread on each other, and the loser is not merely delayed: the
 * `currentUploadSession` / `deleteUploadSession` cleanup both workers run means
 * one of them DELETES the session the other is uploading into, which fails the
 * task after the images are already gone.
 *
 * FIFO, so a queue cannot starve: waiters are served in arrival order rather
 * than by whoever happens to retry first.
 */
export class UploadSessionLock {
  /**
   * The tail of the queue of waiters. Each caller chains onto it and publishes
   * its own completion as the new tail, so the chain IS the ordering; nothing
   * else keeps a list.
   */
  private tail: Promise<unknown> = Promise.resolve();
  private held = false;
  private waiting = 0;

  /** True while a worker holds the session. Reported, never branched on. */
  get busy(): boolean {
    return this.held;
  }

  /** How many workers are queued behind the holder. */
  get queued(): number {
    return this.waiting;
  }

  /**
   * Run `fn` with the session held, releasing it however `fn` ends.
   *
   * The `catch` on the chained tail is deliberate: a rejected turn must not
   * become the tail every later waiter awaits, or one failed upload would
   * reject every subsequent one. The result is still returned to ITS caller.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const turn = this.tail.then(
      () => undefined,
      () => undefined,
    );
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await turn;
    this.waiting -= 1;
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}
