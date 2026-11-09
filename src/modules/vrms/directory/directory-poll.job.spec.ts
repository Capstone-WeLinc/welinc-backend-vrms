import { DirectoryPollJob } from './directory-poll.job';
import type { DirectorySync } from './directory-sync.service';

// Spec 0005, AC-12 and AC-16: one tick at a time inside this process.

describe('DirectoryPollJob', () => {
  it('runs one sync tick', async () => {
    const tick = jest.fn().mockResolvedValue(undefined);
    const job = new DirectoryPollJob({ tick } as unknown as DirectorySync);
    await job.run();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the last one is still running', async () => {
    let finish!: () => void;
    const tick = jest.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const job = new DirectoryPollJob({ tick } as unknown as DirectorySync);
    const first = job.run();
    await job.run();
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('runs again after a tick fails, and lets the error out', async () => {
    const tick = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);
    const job = new DirectoryPollJob({ tick } as unknown as DirectorySync);
    await expect(job.run()).rejects.toThrow('db down');
    await job.run();
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
