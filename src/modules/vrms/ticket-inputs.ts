import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CORPORATION_LIST } from './lookups/lookup-lists';

// Spec 0016 rules for a ticket's driver and corporation, shared by create and the details edit
// (spec 0019, AC-4 and AC-7), so both answer the same way.

type Db = Pick<Prisma.TransactionClient, 'driver' | 'lookupValue'>;

export type DriverRow = { id: string; name: string; licenseNumber: string };

export function driverExists(driver: { id: string; name: string }) {
  return new ConflictException({
    statusCode: 409,
    code: 'DRIVER_EXISTS',
    message: `A driver with this license exists: ${driver.name}.`,
    driver: { id: driver.id, name: driver.name },
  });
}

/** An existing driver picked by id; 400 when they are no longer active. */
export async function activeDriver(db: Db, id: string): Promise<DriverRow> {
  const driver = await db.driver.findFirst({
    where: { id, isActive: true, deletedAt: null },
    select: { id: true, name: true, licenseNumber: true },
  });
  if (!driver) {
    throw new BadRequestException(
      'This driver is no longer available. Choose another.',
    );
  }
  return driver;
}

/**
 * A new driver by LTO license, inside the caller's transaction (spec 0016, AC-6): an active owner
 * answers 409 DRIVER_EXISTS, an inactive or deleted one is reactivated with its stored name (never
 * renamed). `outside` reads the winner of a concurrent insert, since the failed insert has aborted
 * the transaction.
 */
export async function driverForLicense(
  tx: Db,
  outside: Db,
  input: { name: string; licenseNumber: string },
): Promise<DriverRow> {
  const existing = await tx.driver.findUnique({
    where: { licenseNumber: input.licenseNumber },
  });
  if (existing?.isActive && !existing.deletedAt) {
    throw driverExists(existing);
  }
  if (existing) {
    await tx.driver.update({
      where: { id: existing.id },
      data: { isActive: true, deletedAt: null },
    });
    return existing;
  }
  try {
    return await tx.driver.create({
      data: {
        name: input.name,
        licenseNumber: input.licenseNumber,
        isVerified: false,
      },
    });
  } catch (error) {
    // A concurrent insert won the unique index
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await outside.driver.findUnique({
        where: { licenseNumber: input.licenseNumber },
      });
      if (winner) throw driverExists(winner);
    }
    throw error;
  }
}

/**
 * Spec 0019, AC-14: an issue's stored description, built the one way create builds it. A blank
 * description with a linked entry takes the entry's name (spec 0016, AC-5).
 */
export function issueDescription(
  system: string,
  rootCause: string,
  description: string | undefined,
  entryName: string | undefined,
): string {
  return `[${system}] ${rootCause}: ${description || entryName || ''}`;
}

/**
 * Spec 0019, AC-15: the text after a stored description's leading "[System] " (root cause
 * included), which the edit dialog prefills; the system goes back on in front when it saves.
 */
export function issueText(description: string): string {
  return description.replace(/^\[[^\]]*\]\s*/, '');
}

/**
 * The corporation name to store (spec 0016, AC-4): the active lookup value's name, a snapshot.
 * 400 when none is chosen or it is no longer active.
 */
export async function corporationName(
  db: Db,
  corporationId: string | undefined,
): Promise<string> {
  if (!corporationId) throw new BadRequestException('Choose a corporation.');
  const value = await db.lookupValue.findFirst({
    where: { id: corporationId, list: CORPORATION_LIST, isActive: true },
    select: { name: true },
  });
  if (!value) {
    throw new BadRequestException(
      'This corporation is no longer available. Choose another.',
    );
  }
  return value.name;
}
