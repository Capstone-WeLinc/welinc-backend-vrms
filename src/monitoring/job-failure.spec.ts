import * as Sentry from '@sentry/nestjs';
import { reportJobFailure } from './job-failure';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

// VRMS spec 0025, AC-10: a job failure is one issue tagged with the job name, and never throws.

describe('reportJobFailure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('captures the error tagged with the job name', () => {
    const error = new Error('provider down');
    reportJobFailure('embedding-catchup', error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { job: 'embedding-catchup' },
    });
  });

  it('never throws, even when the SDK does', () => {
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sdk broke');
    });
    expect(() =>
      reportJobFailure('attachment-purge', new Error('x')),
    ).not.toThrow();
  });
});
