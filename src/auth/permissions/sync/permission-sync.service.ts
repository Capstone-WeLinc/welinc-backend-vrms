import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../shared/prisma.service';
import {
  AuthPermissionsClient,
  PermissionsUnavailableError,
  type MatrixAnswer,
} from './auth-permissions.client';
import { matrixRows } from './matrix-rows';

// Suite spec 0013, AC-29: VRMS's copy of its permission matrix, kept in step with welinc-auth.

export const PERMISSION_SYNC_MS = 60_000;
export const PERMISSION_LEASE_MS = 120_000;

const STATE_ID = 'auth';

export type PermissionTick =
  | { kind: 'skipped' } // another copy holds the lease
  | { kind: 'unchanged' }
  | { kind: 'applied'; etag: string; rows: number }
  | { kind: 'refused' } // an empty matrix: the last copy stays
  | { kind: 'failed'; reason: string };

/**
 * One tick: claim the lease, ask welinc-auth with the stored ETag, and on a new answer replace
 * every role_permissions row and raise permission_matrix.version in one transaction, so every
 * replica reloads on its next request (the spec 0011 version check). Any other ETag counts as
 * new, older or not (a restore from backup). On failure the last copy stays and the job warns
 * once until it works again.
 */
@Injectable()
export class PermissionSync {
  private readonly logger = new Logger(PermissionSync.name);
  /** Drift is warned once per key per process (AC-29). */
  private readonly warnedDrift = new Set<string>();
  private readonly applied: (() => void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AuthPermissionsClient,
  ) {}

  /**
   * Called after this process applied a new matrix. PermissionsService reloads at once, so the
   * mechanic roster recomputes within one sync, even with no request coming in (suite spec 0018
   * child 0002, AC-33). Other replicas reload on their next checked request, as before.
   */
  whenApplied(listener: () => void): void {
    this.applied.push(listener);
  }

  async tick(): Promise<PermissionTick> {
    const lease = await this.claim();
    if (!lease) return { kind: 'skipped' };
    try {
      let answer: MatrixAnswer;
      try {
        answer = await this.client.read(lease.etag);
      } catch (error) {
        if (!(error instanceof PermissionsUnavailableError)) throw error;
        await this.failing(lease.owner, lease.failingSince, error.reason);
        return { kind: 'failed', reason: error.reason };
      }
      if (answer.kind === 'unchanged') {
        await this.recovered(lease.owner, lease.failingSince);
        return { kind: 'unchanged' };
      }

      const plan = matrixRows(answer.matrix);
      if (plan.kind === 'empty') {
        await this.failing(
          lease.owner,
          lease.failingSince,
          `${answer.etag} grants nothing to any role, refused`,
        );
        return { kind: 'refused' };
      }
      this.warnDrift('unknown', plan.unknownKeys);
      this.warnDrift('missing', plan.missingKeys);

      const applied = await this.prisma.$transaction(async (tx) => {
        // The lease is checked inside the write, so a copy that lost it writes nothing
        const { count } = await tx.permissionSyncState.updateMany({
          where: { id: STATE_ID, leaseOwner: lease.owner },
          data: { etag: answer.etag, syncedAt: new Date(), failingSince: null },
        });
        if (count === 0) return false;
        await tx.rolePermission.deleteMany({});
        await tx.rolePermission.createMany({ data: plan.rows });
        await tx.permissionMatrix.update({
          where: { id: 1 },
          data: { version: { increment: 1 } },
        });
        return true;
      });
      if (!applied) return { kind: 'skipped' };
      if (lease.failingSince)
        this.logger.log('welinc-auth permission matrix is back');
      this.logger.log(
        `Applied permission matrix ${answer.etag} (${plan.rows.length} cells)`,
      );
      for (const listener of this.applied) listener();
      return { kind: 'applied', etag: answer.etag, rows: plan.rows.length };
    } finally {
      await this.release(lease.owner);
    }
  }

  private warnDrift(kind: 'unknown' | 'missing', keys: string[]) {
    for (const key of keys) {
      const id = `${kind}|${key}`;
      if (this.warnedDrift.has(id)) continue;
      this.warnedDrift.add(id);
      this.logger.warn(
        kind === 'unknown'
          ? `welinc-auth sent permission ${key}, which VRMS doesn't check; ignored`
          : `VRMS checks permission ${key}, which welinc-auth's matrix lacks; it counts as off`,
      );
    }
  }

  private async claim(): Promise<{
    owner: string;
    etag: string | null;
    failingSince: Date | null;
  } | null> {
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<
      { etag: string | null; failing_since: Date | null }[]
    >`
      UPDATE "permission_sync_state"
         SET "lease_owner" = ${owner}::uuid,
             "lease_until" = now() + make_interval(secs => ${PERMISSION_LEASE_MS / 1000})
       WHERE "id" = ${STATE_ID}
         AND ("lease_until" IS NULL OR "lease_until" < now())
      RETURNING "etag", "failing_since"`;
    if (rows.length === 0) return null;
    return { owner, etag: rows[0].etag, failingSince: rows[0].failing_since };
  }

  private async release(owner: string): Promise<void> {
    try {
      await this.prisma.permissionSyncState.updateMany({
        where: { id: STATE_ID, leaseOwner: owner },
        data: { leaseOwner: null, leaseUntil: null },
      });
    } catch (error) {
      // The lease runs out on its own in 2 minutes
      this.logger.warn(
        `Could not release the permission sync lease: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** One warning when the sync starts failing, nothing on later failing ticks. */
  private async failing(owner: string, since: Date | null, reason: string) {
    if (since !== null) return;
    this.logger.warn(
      `Permission matrix sync failing (${reason}); VRMS keeps its last copy`,
    );
    await this.prisma.permissionSyncState.updateMany({
      where: { id: STATE_ID, leaseOwner: owner },
      data: { failingSince: new Date() },
    });
  }

  private async recovered(owner: string, since: Date | null) {
    if (since === null) return;
    const seconds = Math.round((Date.now() - since.getTime()) / 1000);
    this.logger.log(`Permission matrix sync is back after ${seconds} s`);
    await this.prisma.permissionSyncState.updateMany({
      where: { id: STATE_ID, leaseOwner: owner },
      data: { failingSince: null },
    });
  }
}
