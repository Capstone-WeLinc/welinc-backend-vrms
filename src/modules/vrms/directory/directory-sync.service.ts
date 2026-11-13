import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { authUnavailable } from '../../../auth/verify/errors';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../shared/prisma.service';
import {
  MechanicRoster,
  type ApplyOutcome,
  type SyncResult,
} from '../mechanic-roster.service';
import { releaseInTx, releaseLeaver } from '../mechanic-work.service';
import { SYSTEM_ACTOR } from '../audit-events';
import {
  AuthDirectoryClient,
  DirectoryCursorError,
  DirectoryUnavailableError,
  type DirectoryUser,
} from './auth-directory.client';
import { rewriteErased } from './erasure-rewrite';
import { applyPerson, sweepPeople } from './people-copy';

/** Spec 0005, AC-12: how often the poll job runs. A constant, not a setting. */
export const DIRECTORY_POLL_MS = 30_000;
/** AC-16: how long a claim lasts unless renewed (after each page). */
export const LEASE_MS = 120_000;
/** AC-12: feed pages read in one tick; the next tick continues. */
export const MAX_PAGES_PER_TICK = 10;

const STATE_ID = 'auth';

type Db = Prisma.TransactionClient;

/** Another copy took the lease: stop at once, write nothing more. */
export class LeaseLostError extends Error {
  constructor() {
    super('directory sync lease lost');
    this.name = 'LeaseLostError';
  }
}

/** AC-17: another copy holds the lease. */
const syncRunning = () =>
  new ConflictException({
    statusCode: 409,
    code: 'SYNC_RUNNING',
    message:
      'A mechanic list update is already running. Try again in a minute.',
    error: 'Conflict',
  });

export type TickOutcome =
  | { kind: 'skipped' } // another copy holds the lease
  | { kind: 'full'; result: SyncResult }
  | { kind: 'changes'; applied: number }
  | { kind: 'stopped' } // a change failed to apply, or the lease was lost
  | { kind: 'reset' } // INVALID_CURSOR: the next tick reads everything again
  | { kind: 'failing' }; // welinc-auth unavailable

/**
 * Keeps VRMS's mechanic roster current from welinc-auth's directory feed (spec 0005). One copy
 * at a time works the feed, under a lease in `directory_sync_state`; every cursor write carries
 * the lease owner, so a copy that lost its lease can never move the cursor.
 */
@Injectable()
export class DirectorySync {
  private readonly logger = new Logger(DirectorySync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roster: MechanicRoster,
    private readonly directory: AuthDirectoryClient,
  ) {}

  /** One poll tick (AC-12). Never throws. */
  async tick(): Promise<TickOutcome> {
    const lease = await this.claim();
    if (!lease) return { kind: 'skipped' };
    try {
      const outcome = await this.work(lease.owner, lease.cursor);
      if (outcome.kind !== 'failing' && outcome.kind !== 'stopped') {
        await this.recovered(lease.owner, lease.failingSince);
      }
      return outcome;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.logger.warn(
          'Lost the directory sync lease to another copy; stopping',
        );
        return { kind: 'stopped' };
      }
      if (error instanceof DirectoryUnavailableError) {
        await this.failing(lease.owner, lease.failingSince, error.reason);
        return { kind: 'failing' };
      }
      this.logger.error(
        `Directory sync tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'stopped' };
    } finally {
      await this.release(lease.owner);
    }
  }

  /**
   * AC-17: `POST /vrms/mechanics/sync`, the recovery path. Claims the lease (409 `SYNC_RUNNING`
   * when another copy holds it), runs the full read and saves its `changesCursor`.
   */
  async recover(): Promise<SyncResult> {
    const lease = await this.claim();
    if (!lease) throw syncRunning();
    try {
      const result = await this.fullRead(lease.owner);
      await this.recovered(lease.owner, lease.failingSince);
      return result;
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) {
        this.logger.warn(
          `Recovery sync could not reach welinc-auth: ${error.reason}`,
        );
        throw authUnavailable();
      }
      if (error instanceof LeaseLostError) throw syncRunning();
      throw error;
    } finally {
      await this.release(lease.owner);
    }
  }

  private async work(
    owner: string,
    cursor: string | null,
  ): Promise<TickOutcome> {
    // Suite spec 0014 (task 13a): an empty Users page copy was never filled (an older copy of VRMS
    // may have run the full read the migration asked for), so read everything once more
    if (cursor === null || (await this.prisma.vrmsPerson.count()) === 0) {
      return { kind: 'full', result: await this.fullRead(owner) };
    }
    try {
      return await this.readChanges(owner, cursor);
    } catch (error) {
      if (!(error instanceof DirectoryCursorError)) throw error;
      // AC-12: a restored or rebuilt auth database; the next tick reads everything again
      this.logger.warn(
        'welinc-auth refused the stored directory cursor; the next tick reads every user again',
      );
      await this.setCursor(this.prisma, owner, null);
      return { kind: 'reset' };
    }
  }

  /**
   * AC-12 and AC-17: pages every VRMS user, applies each, sets inactive every active mechanic
   * row whose person did not appear, and only then saves the first page's `changesCursor`. A
   * crash halfway leaves the cursor as it was, so the next run starts over.
   */
  async fullRead(owner: string): Promise<SyncResult> {
    const result: SyncResult = { created: 0, updated: 0, deactivated: 0 };
    const seen = new Set<string>();
    let startCursor: string | null = null;
    let page: string | null = null;

    do {
      const answer = await this.directory.listUsers(page);
      startCursor ??= answer.changesCursor;
      for (const user of answer.users) {
        seen.add(user.id);
        // Suite spec 0012, AC-24, AC-25: the roster, then the leaver's tickets and an erasure,
        // together. The first full read after this shipped releases people already inactive
        const outcome = await this.prisma.$transaction((tx) =>
          this.applyChange(user, tx),
        );
        if (outcome !== 'unchanged') result[outcome]++;
      }
      await this.renew(owner);
      page = answer.next;
    } while (page !== null);

    // Suite spec 0014 (task 13a): out of the VRMS directory means off the Users page too
    await sweepPeople(this.prisma, seen);

    const gone = await this.prisma.mechanic.findMany({
      where: { isActive: true },
      select: { id: true, authUserId: true },
    });
    const ids = gone
      .filter((row) => !seen.has(row.authUserId))
      .map((row) => row.id);
    if (ids.length > 0) {
      const { count } = await this.prisma.mechanic.updateMany({
        where: { id: { in: ids }, isActive: true },
        data: { isActive: false },
      });
      result.deactivated += count;
      // Suite spec 0012, AC-24: out of the VRMS directory means no VRMS role any more
      for (const id of ids) {
        await this.prisma.$transaction((tx) =>
          releaseInTx(tx, id, 'ROLE_REMOVED', SYSTEM_ACTOR, new Date()),
        );
      }
    }

    await this.setCursor(this.prisma, owner, startCursor);
    return result;
  }

  /**
   * Suite spec 0012, AC-24, AC-25: one person, inside the caller's transaction. The roster first,
   * as before; then a person who is deleted, inactive or without a mechanic role leaves their
   * open tickets; then an erased person's name and email copies become "Deleted user". Each step
   * keys on the snapshot's state, so applying the same change again changes nothing more.
   */
  private async applyChange(
    user: DirectoryUser,
    tx: Prisma.TransactionClient,
  ): Promise<ApplyOutcome> {
    // Suite spec 0014 (task 13a): the Users page copy, for every VRMS person
    await applyPerson(tx, user);
    const outcome = await this.roster.apply(user, tx);
    const released = await releaseLeaver(tx, user);
    if (released.released > 0) {
      this.logger.log(
        `Released ${released.released} tickets from ${user.id} after a directory change`,
      );
    }
    if (user.erased) await rewriteErased(tx, user.id);
    return outcome;
  }

  /**
   * AC-12 and AC-14: reads the feed from `cursor`, up to 10 pages, applying each change and
   * moving the cursor past it in one transaction. A change that fails stops the tick with the
   * cursor before it, so the next tick tries it again.
   */
  private async readChanges(
    owner: string,
    cursor: string,
  ): Promise<TickOutcome> {
    let applied = 0;
    let at = cursor;

    for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages++) {
      const answer = await this.directory.changes(at);

      for (const change of answer.changes) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.applyChange(change.user, tx);
            await this.setCursor(tx, owner, change.cursor);
          });
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          this.logger.error(
            `Could not apply directory change ${change.cursor} for ${change.user.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return { kind: 'stopped' };
        }
        applied++;
        at = change.cursor;
      }

      // A short page answers the safe point as `next`: move there so the rows are not read again
      if (answer.next !== at) {
        await this.setCursor(this.prisma, owner, answer.next);
        at = answer.next;
      }
      await this.renew(owner);
      if (!answer.hasMore) break;
    }
    return { kind: 'changes', applied };
  }

  /** AC-16: one UPDATE that takes the lease only when nobody holds it. */
  async claim(): Promise<{
    owner: string;
    cursor: string | null;
    failingSince: Date | null;
  } | null> {
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<
      { cursor: string | null; failing_since: Date | null }[]
    >`
      UPDATE "directory_sync_state"
         SET "lease_owner" = ${owner}::uuid,
             "lease_until" = now() + make_interval(secs => ${LEASE_MS / 1000})
       WHERE "id" = ${STATE_ID}
         AND ("lease_until" IS NULL OR "lease_until" < now())
      RETURNING "cursor", "failing_since"`;
    if (rows.length === 0) return null;
    return {
      owner,
      cursor: rows[0].cursor,
      failingSince: rows[0].failing_since,
    };
  }

  private async renew(owner: string): Promise<void> {
    const count = await this.prisma.$executeRaw`
      UPDATE "directory_sync_state"
         SET "lease_until" = now() + make_interval(secs => ${LEASE_MS / 1000})
       WHERE "id" = ${STATE_ID} AND "lease_owner" = ${owner}::uuid`;
    if (count === 0) throw new LeaseLostError();
  }

  async release(owner: string): Promise<void> {
    try {
      await this.prisma.directorySyncState.updateMany({
        where: { id: STATE_ID, leaseOwner: owner },
        data: { leaseOwner: null, leaseUntil: null },
      });
    } catch (error) {
      // The lease runs out on its own in 2 minutes
      this.logger.warn(
        `Could not release the directory sync lease: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Every cursor write checks the owner; no match means the lease was lost (AC-16). */
  private async setCursor(
    db: Db,
    owner: string,
    cursor: string | null,
  ): Promise<void> {
    const { count } = await db.directorySyncState.updateMany({
      where: { id: STATE_ID, leaseOwner: owner },
      data: { cursor, updatedAt: new Date() },
    });
    if (count === 0) throw new LeaseLostError();
  }

  /** AC-15: one warning when welinc-auth starts failing, nothing on later failing ticks. */
  private async failing(
    owner: string,
    since: Date | null,
    reason: string,
  ): Promise<void> {
    if (since !== null) return;
    this.logger.warn(
      `welinc-auth's directory is unavailable (${reason}); the mechanic list keeps its last known state`,
    );
    await this.prisma.directorySyncState.updateMany({
      where: { id: STATE_ID, leaseOwner: owner },
      data: { failingSince: new Date() },
    });
  }

  /** AC-15: one line on the first good tick, saying how long it was failing. */
  private async recovered(owner: string, since: Date | null): Promise<void> {
    if (since === null) return;
    const seconds = Math.round((Date.now() - since.getTime()) / 1000);
    this.logger.log(`welinc-auth's directory is back after ${seconds} s`);
    await this.prisma.directorySyncState.updateMany({
      where: { id: STATE_ID, leaseOwner: owner },
      data: { failingSince: null },
    });
  }
}
