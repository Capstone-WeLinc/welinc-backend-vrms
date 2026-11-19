import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { reportJobFailure } from '../../monitoring/job-failure';
import { PrismaService } from '../../shared/prisma.service';
import { attachmentIdFromKey, FILE_STORE, type FileStore } from './file-store';

// Spec 0017, AC-19: removed files lose their bytes after 30 days, and blobs no row points at are
// swept after 24 hours. One replica at a time, both steps idempotent.

const DAY = 24 * 60 * 60 * 1000;
export const PURGE_AFTER_DAYS = 30;
export const ORPHAN_AFTER_HOURS = 24;
const BATCH = 100;
const BOOT_DELAY = 2 * 60 * 1000;

export type PurgeResult = { purged: number; orphans: number; skipped?: true };

/** Rows removed more than 30 days ago whose bytes are still stored. */
export function purgeDueWhere(now: Date): Prisma.AttachmentWhereInput {
  return {
    deletedAt: { lt: new Date(now.getTime() - PURGE_AFTER_DAYS * DAY) },
    purgedAt: null,
  };
}

@Injectable()
export class AttachmentPurgeJob
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AttachmentPurgeJob.name);
  private bootTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORE) private readonly store: FileStore,
  ) {}

  /** Staging scales to zero and may sleep through 03:00, so a pass also runs after boot. */
  onApplicationBootstrap() {
    if (!this.store.configured) return;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.runAfterBoot();
    }, BOOT_DELAY);
    this.bootTimer.unref();
  }

  onApplicationShutdown() {
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }

  @Cron('0 0 3 * * *', { timeZone: 'Asia/Manila' })
  async nightly(): Promise<void> {
    await this.safeRun();
  }

  /** Only when a due row exists, so a cold start does not list the whole container. */
  async runAfterBoot(): Promise<void> {
    try {
      const due = await this.prisma.attachment.count({
        where: purgeDueWhere(new Date()),
      });
      if (due > 0) await this.safeRun();
    } catch (error) {
      this.logger.warn(`Retention check after boot failed: ${String(error)}`);
      reportJobFailure('attachment-purge', error);
    }
  }

  private async safeRun() {
    try {
      const result = await this.run();
      if (result.purged || result.orphans) {
        this.logger.log(
          `Retention purged ${result.purged} file(s) and swept ${result.orphans} orphan blob(s)`,
        );
      }
    } catch (error) {
      // The next pass tries again; both steps are idempotent
      this.logger.warn(`Retention pass stopped: ${String(error)}`);
      reportJobFailure('attachment-purge', error);
    }
  }

  /** One pass, holding a transaction scoped advisory lock; a replica without it skips. */
  async run(now: Date = new Date()): Promise<PurgeResult> {
    if (!this.store.configured) return { purged: 0, orphans: 0, skipped: true };
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended('attachments.retention', 0)) AS locked
        `;
        if (!locked) return { purged: 0, orphans: 0, skipped: true as const };
        const purged = await this.purge(tx, now);
        const orphans = await this.sweepOrphans(tx, now);
        return { purged, orphans };
      },
      { timeout: 10 * 60 * 1000, maxWait: 5_000 },
    );
  }

  /** Deletes the bytes first, then sets purgedAt, so a crash in between is harmless. */
  private async purge(tx: Prisma.TransactionClient, now: Date) {
    let purged = 0;
    const failed: string[] = [];
    for (;;) {
      const rows = await tx.attachment.findMany({
        where: { ...purgeDueWhere(now), id: { notIn: failed } },
        select: { id: true, storageKey: true, thumbnailKey: true },
        orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
      });
      if (rows.length === 0) return purged;

      const done: string[] = [];
      for (const row of rows) {
        try {
          // A missing blob counts as deleted
          await this.store.delete(row.storageKey);
          if (row.thumbnailKey) await this.store.delete(row.thumbnailKey);
          done.push(row.id);
        } catch (error) {
          failed.push(row.id);
          this.logger.warn(
            `Could not purge attachment ${row.id}: ${String(error)}`,
          );
        }
      }
      if (done.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: done } },
          data: { purgedAt: now },
        });
        purged += done.length;
      }
      if (rows.length < BATCH) return purged;
    }
  }

  /** Blobs under tickets/ with no row, first written over 24 hours ago (createdOn, never lastModified). */
  private async sweepOrphans(tx: Prisma.TransactionClient, now: Date) {
    const cutoff = now.getTime() - ORPHAN_AFTER_HOURS * 60 * 60 * 1000;
    let removed = 0;
    let batch: { name: string; id: string }[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const ids = [...new Set(batch.map((b) => b.id))];
      const known = await tx.attachment.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const exists = new Set(known.map((k) => k.id));
      for (const blob of batch) {
        if (exists.has(blob.id)) continue;
        try {
          await this.store.delete(blob.name);
          removed++;
        } catch (error) {
          this.logger.warn(
            `Could not delete orphan blob ${blob.name}: ${String(error)}`,
          );
        }
      }
      batch = [];
    };

    for await (const blob of this.store.list('tickets/')) {
      const id = attachmentIdFromKey(blob.name);
      // An in flight upload is younger than the cutoff, so it is left alone
      if (!id || !blob.createdOn || blob.createdOn.getTime() >= cutoff)
        continue;
      batch.push({ name: blob.name, id });
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    return removed;
  }
}
