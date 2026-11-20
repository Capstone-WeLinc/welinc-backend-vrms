import * as Sentry from '@sentry/nestjs';
import type { DirectoryPollMonitor } from '../../../monitoring/directory-poll-monitor';
import { DirectoryPollJob } from './directory-poll.job';
import type { DirectorySync, TickOutcome } from './directory-sync.service';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

// Spec 0005, AC-12 and AC-16: one tick at a time inside this process.
// Spec 0025, AC-10: check ins per outcome, and a thrown tick reported, never rethrown.

function setup(tick: jest.Mock) {
  const monitor = { ok: jest.fn(), error: jest.fn() };
  const job = new DirectoryPollJob(
    { tick } as unknown as DirectorySync,
    monitor as unknown as DirectoryPollMonitor,
  );
  return { job, monitor };
}

describe('DirectoryPollJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs one sync tick', async () => {
    const tick = jest.fn().mockResolvedValue({ kind: 'changes', applied: 0 });
    const { job } = setup(tick);
    await job.run();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the last one is still running', async () => {
    let finish!: (outcome: TickOutcome) => void;
    const tick = jest.fn(
      () => new Promise<TickOutcome>((resolve) => (finish = resolve)),
    );
    const { job } = setup(tick);
    const first = job.run();
    await job.run();
    expect(tick).toHaveBeenCalledTimes(1);
    finish({ kind: 'changes', applied: 0 });
    await first;
  });

  it.each<[TickOutcome, 'ok' | 'error' | 'none']>([
    [{ kind: 'changes', applied: 2 }, 'ok'],
    [{ kind: 'reset' }, 'ok'],
    [{ kind: 'failing' }, 'error'],
    [{ kind: 'error' }, 'error'],
    [{ kind: 'skipped' }, 'none'],
    [{ kind: 'stopped' }, 'none'],
  ])('checks in for %j as %s', async (outcome, expected) => {
    const { job, monitor } = setup(jest.fn().mockResolvedValue(outcome));
    await job.run();
    expect(monitor.ok).toHaveBeenCalledTimes(expected === 'ok' ? 1 : 0);
    expect(monitor.error).toHaveBeenCalledTimes(expected === 'error' ? 1 : 0);
  });

  it('reports a tick that throws with the job tag, checks in error, and runs again', async () => {
    const failure = new Error('db down');
    const tick = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ kind: 'changes', applied: 0 });
    const { job, monitor } = setup(tick);

    await expect(job.run()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      tags: { job: 'directory-poll' },
    });
    expect(monitor.error).toHaveBeenCalledTimes(1);

    await job.run();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(monitor.ok).toHaveBeenCalledTimes(1);
  });
});
