import { Logger } from '@nestjs/common';
import { EmbeddingCatchupJob } from './embedding-catchup.job';
import type { EmbeddingService } from './embedding.service';

function setup() {
  const catchUp = jest.fn();
  const job = new EmbeddingCatchupJob({
    catchUp,
  } as unknown as EmbeddingService);
  return { job, catchUp };
}

describe('EmbeddingCatchupJob (AC-15)', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs how many issues it embedded', async () => {
    const { job, catchUp } = setup();
    catchUp.mockResolvedValue(3);
    await job.run();
    expect(log).toHaveBeenCalledWith('Catch up embedded 3 issue(s)');
  });

  it('stays quiet when nothing needed embedding', async () => {
    const { job, catchUp } = setup();
    catchUp.mockResolvedValue(0);
    await job.run();
    expect(log).not.toHaveBeenCalled();
  });

  it('swallows a provider error and warns, so the next run can retry', async () => {
    const { job, catchUp } = setup();
    catchUp.mockRejectedValue(new Error('quota'));
    await expect(job.run()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Catch up stopped: quota');
  });

  it('also copes with a thrown non Error value', async () => {
    const { job, catchUp } = setup();
    catchUp.mockRejectedValue('oops');
    await expect(job.run()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Catch up stopped: oops');
  });
});
