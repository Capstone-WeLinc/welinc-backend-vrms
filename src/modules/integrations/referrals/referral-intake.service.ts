import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type ReferralStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import { applyFleetVehicle } from '../fleet/fleet-apply';
import {
  FleetUnavailableError,
  VmmsFleetClient,
  type FleetVehicle,
} from '../fleet/vmms-fleet.client';
import { payloadHash, storedReferral } from './referral-intake';
import type { RepairReferralDto } from './repair-referral.dto';

export type IntakeAnswer = {
  referralId: string;
  status: ReferralStatus;
  duplicate: boolean;
};

/**
 * Spec 0029 (child 0002), AC-6: stores a VMMS referral as `WAITING`. The referral id is the key,
 * so a resend with the same body answers the first answer again and a changed body is refused.
 */
@Injectable()
export class ReferralIntakeService {
  private readonly logger = new Logger(ReferralIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: VmmsFleetClient,
  ) {}

  async receive(
    dto: RepairReferralDto,
    rawBody: unknown,
    now = new Date(),
  ): Promise<IntakeAnswer> {
    const hash = payloadHash(rawBody);
    const seen = await this.existing(dto.referralId, hash);
    if (seen) return seen;

    // A truck VRMS hasn't copied yet: read it fresh before the transaction (child 0001)
    let fresh: FleetVehicle | null = null;
    const known = await this.prisma.vehicle.findUnique({
      where: { vmmsVehicleId: dto.vmmsVehicleId },
      select: { id: true },
    });
    if (!known) {
      try {
        fresh = await this.fleet.vehicle(dto.vmmsVehicleId);
      } catch (error) {
        if (!(error instanceof FleetUnavailableError)) throw error;
        // VMMS can't confirm the truck now; a 503 makes VMMS's sender retry
        this.logger.warn(
          `Referral ${dto.referralId}: truck lookup failed (${error.reason})`,
        );
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'VMMS_UNAVAILABLE',
          message: "VMMS can't be reached to confirm the truck. Try again.",
        });
      }
      if (!fresh) throw vehicleNotFound();
    }

    const text = storedReferral(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const vehicleId =
          known?.id ??
          (await applyFleetVehicle(tx, fresh!, now)).localId ??
          null;
        if (!vehicleId) throw vehicleNotFound();
        await tx.referral.create({
          data: {
            id: dto.referralId,
            vehicleId,
            vmmsVehicleId: dto.vmmsVehicleId,
            vehiclePlate: text.vehiclePlate,
            maintenanceScheduleId: dto.maintenanceScheduleId,
            workOrderNumber: text.workOrderNumber,
            odometerReading: dto.odometerReading,
            findings: text.findings,
            chiefMechanicRemarks: text.chiefMechanicRemarks,
            receivedAt: now,
            payloadHash: hash,
          },
        });
        return {
          referralId: dto.referralId,
          status: 'WAITING' as const,
          duplicate: false,
        };
      });
    } catch (error) {
      // Two copies of the same referral raced; the first won, so answer as a resend
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.existing(dto.referralId, hash);
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async existing(
    referralId: string,
    hash: string,
  ): Promise<IntakeAnswer | null> {
    const row = await this.prisma.referral.findUnique({
      where: { id: referralId },
      select: { status: true, payloadHash: true },
    });
    if (!row) return null;
    if (row.payloadHash !== hash) {
      throw new ConflictException({
        statusCode: 409,
        code: 'REFERRAL_ID_REUSED',
        message: 'This referral id was already received with a different body.',
      });
    }
    return { referralId, status: row.status, duplicate: true };
  }
}

const vehicleNotFound = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'VEHICLE_NOT_FOUND',
    message: 'VMMS has no truck with this id.',
  });
