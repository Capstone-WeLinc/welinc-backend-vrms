/** At most `limit` tasks run at once in this replica; the rest wait in order. */
export class Semaphore {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter, so the count never dips
      if (next) next();
      else this.running--;
    }
  }
}
