import { Injectable } from '@nestjs/common';
import type { DeliveryKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { LEASE_EXPIRED, LEASE_MS, type RowUpdate } from './retry-rule';

/** A row the worker claimed. `attempts` already counts the send about to happen. */
export type ClaimedDelivery = {
  id: string;
  kind: DeliveryKind;
  payload: Prisma.JsonObject;
  attempts: number;
  firstAttemptAt: Date;
  repairTicketId: string | null;
};

export const CLAIM_LIMIT = 50;

/**
 * Spec 0029 (child 0004): the outbox's SQL, kept apart from the worker so the worker's logic is
 * tested without a database.
 */
@Injectable()
export class DeliveryStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to 50 due rows in one transaction. For rows with a ticket, only the head of each
   * (target, ticket) line is eligible: the oldest row still `PENDING` or `FAILED`, so a failed
   * row blocks its line until it is retried or dismissed (AC-21). Rows with no ticket are claimed
   * when due. Each claimed row is leased for 60 s and its attempt is counted now, with
   * `lease_expired` as its error until the send's answer overwrites it, so a worker that dies
   * mid send leaves a counted attempt and the row comes back after the lease.
   */
  async claim(now: Date): Promise<ClaimedDelivery[]> {
    return this.prisma.$transaction(async (tx) => {
      // One claimer at a time across replicas; SKIP LOCKED and the recheck below cover the rest
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('integration.delivery-claim', 0)) AS locked
      `;
      if (!locked) return [];
      const due = await tx.$queryRaw<{ id: string }[]>`
        WITH heads AS (
          SELECT DISTINCT ON (target, repair_ticket_id) id
          FROM deliveries
          WHERE status IN ('PENDING', 'FAILED') AND repair_ticket_id IS NOT NULL
          ORDER BY target, repair_ticket_id, seq
        )
        SELECT d.id
        FROM deliveries d
        WHERE d.status = 'PENDING'
          AND d.next_attempt_at <= ${now}
          AND (d.repair_ticket_id IS NULL OR d.id IN (SELECT id FROM heads))
        ORDER BY d.seq
        LIMIT ${CLAIM_LIMIT}
        FOR UPDATE OF d SKIP LOCKED
      `;
      if (due.length === 0) return [];
      const lease = new Date(now.getTime() + LEASE_MS);
      return tx.$queryRaw<ClaimedDelivery[]>`
        UPDATE deliveries SET
          attempts = attempts + 1,
          first_attempt_at = COALESCE(first_attempt_at, ${now}),
          last_attempt_at = ${now},
          next_attempt_at = ${lease},
          last_status_code = NULL,
          last_error = ${LEASE_EXPIRED}
        WHERE id = ANY(${due.map((r) => r.id)}::uuid[])
          AND status = 'PENDING'
        RETURNING
          id,
          kind::text AS kind,
          payload,
          attempts,
          first_attempt_at AS "firstAttemptAt",
          repair_ticket_id AS "repairTicketId"
      `;
    });
  }

  /** The last version VMMS accepted for this ticket (0 before the first event). */
  async vmmsEventVersion(repairTicketId: string): Promise<number> {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id: repairTicketId },
      select: { vmmsEventVersion: true },
    });
    return ticket?.vmmsEventVersion ?? 0;
  }

  /**
   * Writes a send's outcome. Only a row still `PENDING` is touched (it is still this worker's
   * lease). A sent versioned row saves its version on the ticket in the same transaction.
   */
  async settle(
    id: string,
    update: RowUpdate,
    now: Date,
    version?: { repairTicketId: string; eventVersion: number },
  ): Promise<void> {
    const data: Prisma.DeliveryUpdateManyMutationInput =
      update.status === 'SENT'
        ? {
            status: 'SENT',
            sentAt: now,
            lastStatusCode: update.lastStatusCode,
            lastError: null,
          }
        : update.status === 'FAILED'
          ? {
              status: 'FAILED',
              lastStatusCode: update.lastStatusCode,
              lastError: update.lastError,
            }
          : {
              nextAttemptAt: update.nextAttemptAt,
              lastStatusCode: update.lastStatusCode,
              lastError: update.lastError,
            };
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: { id, status: 'PENDING' },
        data,
      });
      if (count === 1 && update.status === 'SENT' && version) {
        // Raw SQL on purpose: Prisma's @updatedAt would move the ticket's updatedAt and make
        // every open edit dialog on it stale, for a change no person made
        await tx.$executeRaw`
          UPDATE repair_tickets
          SET vmms_event_version = GREATEST(vmms_event_version, ${version.eventVersion})
          WHERE id = ${version.repairTicketId}::uuid
        `;
      }
    });
  }
}
