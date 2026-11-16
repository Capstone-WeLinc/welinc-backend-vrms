import {
  ArgumentsHost,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { SentryExceptionFilter } from './sentry-exception.filter';

// covers: VRMS spec 0025 AC-1, AC-2

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

const hostFor = (url: string): ArgumentsHost =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, url }) }),
  }) as unknown as ArgumentsHost;

describe('SentryExceptionFilter', () => {
  let filter: SentryExceptionFilter;
  let parent: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    filter = new SentryExceptionFilter();
    parent = jest
      .spyOn(SentryGlobalFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => parent.mockRestore());

  it('reports a 5xx HttpException, then lets Sentry answer', () => {
    const error = new ServiceUnavailableException('AUTH_UNAVAILABLE');
    filter.catch(error, hostFor('/vrms/repairs'));
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.anything(),
    );
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it('does not report a 4xx HttpException', () => {
    filter.catch(new BadRequestException(), hostFor('/vrms/repairs'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not report the health 503', () => {
    filter.catch(new ServiceUnavailableException(), hostFor('/vrms/health'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('leaves a plain error to Sentry’s own filter', () => {
    filter.catch(new Error('boom'), hostFor('/vrms/repairs'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(parent).toHaveBeenCalledTimes(1);
  });
});
