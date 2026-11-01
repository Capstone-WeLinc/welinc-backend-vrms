import { Semaphore } from './semaphore';

// Spec 0017, AC-6: the image and PDF work runs a few at a time per replica.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('Semaphore', () => {
  it('returns what the task returns', async () => {
    await expect(new Semaphore(1).run(() => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });

  it('never runs more than the limit at once and starts waiters in order', async () => {
    const sem = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate, i) =>
      sem.run(async () => {
        started.push(i);
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('frees the slot when a task throws, and passes the error on', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(sem.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('lets a waiter start after a failing task ahead of it', async () => {
    const sem = new Semaphore(1);
    const gate = deferred();
    const first = sem.run(async () => {
      await gate.promise;
      throw new Error('first failed');
    });
    const second = sem.run(() => Promise.resolve('second ran'));
    gate.resolve();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second ran');
  });
});
