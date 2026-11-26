import * as Sentry from '@sentry/nestjs';

/** VRMS spec 0025, AC-10: the fixed job names Sentry issues are tagged with. */
export type JobName =
  | 'directory-poll'
  | 'permission-sync'
  | 'embedding-catchup'
  | 'attachment-purge'
  | 'delivery-worker';

/**
 * Reports a scheduled job's failure as a Sentry issue tagged with the job name. Never throws and
 * never rethrows: a rethrow from a scheduler callback can report twice or stop the scheduler.
 * With no DSN Sentry has no client and this sends nothing (AC-14).
 */
export function reportJobFailure(job: JobName, error: unknown): void {
  try {
    Sentry.captureException(error, { tags: { job } });
  } catch {
    // Monitoring never breaks a job
  }
}
